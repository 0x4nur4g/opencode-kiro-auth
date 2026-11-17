#!/usr/bin/env bun
/**
 * Live probe for the Kiro plugin. Run before every ship:
 *
 *   bun scripts/live-probe.ts [--plugin-dir <abs path>]
 *
 * Starts a private `opencode serve` that loads only the plugin from
 * --plugin-dir (default: this checkout) and checks, from the host side, what
 * unit tests cannot see:
 *
 *   1 plugin active, exactly one `kiro`, loaded from --plugin-dir
 *   2 provider baseURL is a live loopback port owned by the server, and every
 *     variant carries body.thinkingConfig (variant `settings` never reach the
 *     request)
 *   3 variant levels match the effort schema in kiro-models.json
 *   4 real completions carry the effort on the wire (plugin request log)
 *   5 the gateway keeps an idle connection open past Bun's 10 s default
 *   7 a forced gateway rotation: the old listener stops, a new one starts on
 *     another port, the catalog heals a stale record to it, and a completion
 *     works afterwards
 *   6 no ERROR or lock-contention lines from the server's pid in plugin.log
 *     (evaluated last, after shutdown)
 *
 * Check 7 rewrites the probe's own config to insert a fixture plugin before
 * kiro. The host keeps only the unchanged prefix of the plugin list, so kiro's
 * setup re-runs (teardown first: the gateway rotates), and the fixture adds a
 * stale plugin-owned `kiro` record (http://127.0.0.1:0) ahead of kiro's
 * transform. Host v2.3.0 rebuilds every catalog from an empty draft, so a plain
 * reload (POST /api/location/reload) only reaches the transform's add branch;
 * the fixture is what makes the heal branch produce the new port.
 *
 * Needs a logged-in Kiro account and Linux (/proc). Isolation:
 * OPENCODE_CONFIG_DIR and XDG_DATA/STATE/CACHE_HOME live under
 * /tmp/opencode/live-probe-<ts>/. XDG_CONFIG_HOME stays real: the plugin keeps
 * kiro.db, kiro-models.json and kiro-logs there. The user's service and
 * opencode config are never touched; the only files the probe deletes are the
 * API request logs it caused. Exit code: 0 = all PASS, 1 = any FAIL, 2 = bad
 * arguments.
 */
import type { Subprocess } from 'bun'
import { randomBytes } from 'node:crypto'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { connect, type Socket } from 'node:net'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max']
/** Models whose variants must be present and match the schema. */
const REQUIRED_MODELS = ['claude-haiku-5-5', 'claude-sonnet-4-6', 'grok-4.7', 'claude-haiku-4-5']
/** Effort completions; the expected wire field comes from the model's schema. */
const COMPLETIONS = [
  { id: '4a', model: 'claude-haiku-5-5', variant: 'high' },
  { id: '4b', model: 'gpt-5.6-luna', variant: 'low' }
]
const AFTER_ROTATION = { id: '7d', model: 'claude-haiku-5-5', variant: 'high' }
const IDLE_HOLD_MS = 13_000
/** The poisoned provider URL of the original heal bug. */
const STALE_URL = 'http://127.0.0.1:0'
/** Fixture plugin for check 7: a stale plugin-owned kiro record ahead of kiro's transform. */
const STALE_FIXTURE = `// live-probe fixture: a stale plugin-owned kiro provider record.
export default {
  id: 'live-probe-stale-kiro',
  async setup(ctx) {
    const registration = await ctx.provider.transform((draft) => {
      if (draft.get('kiro')) return
      draft.add({
        info: {
          id: 'kiro',
          name: 'Kiro',
          activation: 'enabled',
          package: '@opencode/ai/providers/openai-compatible',
          settings: { baseURL: '${STALE_URL}' }
        },
        models: []
      })
    })
    return () => registration.dispose()
  }
}
`
/** Plugin API log name: optional error_ prefix, request timestamp, kind. */
const API_LOG = /^(?:error_)?(\d{4}-\d{2}-\d{2}T[\d-]+Z)_(?:request|response)\.json$/

// Same resolution as the plugin (src/plugin/storage/sqlite.ts, src/plugin/logger.ts).
const kiroDir = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'opencode')
const logDir = join(kiroDir, 'kiro-logs')
const pluginLog = join(logDir, 'plugin.log')

interface PluginInfo {
  id?: string
  source?: { type?: string; path?: string; target?: string }
  state?: { status?: string; error?: string }
}
interface Variant {
  id: string
  settings?: Record<string, unknown>
  body?: Record<string, unknown>
}
interface Model {
  id: string
  providerID: string
  settings?: { baseURL?: unknown }
  variants?: Variant[]
}
interface WireModel {
  modelId: string
  effort?: { field?: string; levels?: string[] } | null
}
interface LogEntry {
  pid: number
  level: string
  text: string
}

const started = Date.now()
const pluginDir = parseArgs(process.argv.slice(2))
const runDir = `/tmp/opencode/live-probe-${new Date(started).toISOString().replace(/[:.]/g, '-')}`
const workDir = join(runDir, 'work')
const password = randomBytes(32).toString('base64url')
// Other Kiro processes may write API logs into the same directory meanwhile;
// the nonce in the prompt marks the request logs this probe caused.
const nonce = randomBytes(6).toString('hex')
const prompt = `Reply with exactly: OK\n(live-probe ${nonce})`
const auth = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`
const logStart = fileSize(pluginLog)
const logsBefore = new Set(listDir(logDir))
const results: Array<{ id: string; ok: boolean }> = []
const live: {
  server?: Subprocess<'pipe', 'pipe', number>
  url?: string
  apiPort?: number
  pids: Set<number>
  ports: Set<number>
  children: Set<Subprocess>
  sockets: Set<Socket>
} = { pids: new Set(), ports: new Set(), children: new Set(), sockets: new Set() }
let finishing: Promise<number> | undefined
let verdict = false

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    report('interrupted', false, 'probe', signal)
    void finish().then((code) => process.exit(code))
  })
}

try {
  await main()
} catch (error) {
  report('setup', false, 'probe aborted', error instanceof Error ? error.message : String(error))
}
process.exit(await finish())

/** Clean up once, print the verdict, and return the exit code (shared by the signal path). */
function finish(): Promise<number> {
  finishing ??= (async () => {
    for (const note of await cleanup()) console.log(`cleanup: ${note}`)
    const failed = results.filter((r) => !r.ok).map((r) => r.id)
    const elapsed = secs(Date.now() - started)
    verdict = true
    if (failed.length > 0) {
      console.log(`RESULT: FAIL (${failed.join(', ')}) in ${elapsed}; run dir kept: ${runDir}`)
      return 1
    }
    rmSync(runDir, { recursive: true, force: true })
    console.log(`RESULT: PASS (${results.length}/${results.length}) in ${elapsed}`)
    return 0
  })()
  return finishing
}

async function main(): Promise<void> {
  const bin = Bun.which('opencode')
  if (!bin) throw new Error('opencode is not on PATH')
  for (const dir of ['config', 'data', 'state', 'cache', 'work']) {
    mkdirSync(join(runDir, dir), { recursive: true })
  }
  writePlugins([pluginDir])
  const env = childEnv()
  await startServer(bin, env)
  const info = (await api('/api/info')).body as { version?: string; pid?: number } | null
  if (typeof info?.pid === 'number') live.pids.add(info.pid)
  console.log(
    `live-probe: plugin ${pluginDir} (${gitState(pluginDir)}); opencode ${info?.version ?? '?'}; ` +
      `server ${live.url} pid ${[...live.pids].join('/')}; run dir ${runDir}`
  )

  // 1. The plugin is active, unique, and comes from --plugin-dir.
  const plugins = await waitForPlugin()
  const kiro = plugins.filter((p) => p.id === 'kiro')
  const mine = kiro.filter((p) => p.source?.type === 'local' && samePath(p.source.path, pluginDir))
  const extra = plugins.filter((p) => p.source?.type !== 'builtin')
  const configs = await configSources()
  const foreign = configs.filter((path) => !path.startsWith(`${runDir}/`))
  const created = ourLogEntries().find((e) => /Kiro gateway created at/.test(e.text))
  // Describe our entry even when it failed before declaring an id.
  const entry = kiro[0] ?? plugins.find((p) => samePath(p.source?.path, pluginDir))
  const state = entry?.state
  report(
    '1',
    kiro.length === 1 &&
      mine[0]?.state?.status === 'active' &&
      extra.length === 1 &&
      foreign.length === 0 &&
      created !== undefined,
    'plugin',
    [
      `kiro entries ${kiro.length}`,
      `source ${entry?.source?.type ?? 'none'} ${entry?.source?.path ?? entry?.source?.target ?? ''}`,
      `state ${state?.status ?? 'missing'}${state?.error ? ` (${state.error})` : ''}`,
      `non-builtin plugins ${extra.length}`,
      `config sources ${configs.join(', ') || 'none'}${foreign.length ? ' (NOT all in run dir)' : ''}`,
      `plugin.log from server pid: ${created?.text.replace(/^.*?INFO: /, '') ?? 'no gateway setup line'}`
    ].join('; ')
  )
  if (mine[0]?.state?.status !== 'active')
    throw new Error('plugin not active; later checks skipped')

  // Start the idle hold as soon as the gateway port is known, so it overlaps
  // discovery and the completions.
  const port = await waitForGatewayPort()
  if (port) live.ports.add(port)
  const idle = port ? idleHold(port) : Promise.resolve({ open: false, detail: 'no gateway port' })

  // 2 + 3 read the catalog after background discovery has replaced the cached list.
  const discovery = await waitForDiscovery()
  const { baseURL, models } = await stableCatalog()
  const wire = readWireModels()

  // 2. Provider record, listener, and variant transport.
  const catalogPort = gatewayPort(baseURL)
  const own = serverSockets()
  const listening = listeners().filter((l) => l.port === catalogPort)
  const owned = listening.some((l) => own.has(l.inode))
  const rowsElsewhere = models.filter(
    (m) => m.settings?.baseURL !== undefined && m.settings.baseURL !== baseURL
  )
  const variants = models.flatMap((m) => (m.variants ?? []).map((v) => ({ model: m.id, v })))
  const noBody = variants.filter(({ v }) => typeof thinkingBudget(v.body) !== 'number')
  if (catalogPort) live.ports.add(catalogPort)
  const listener = !listening.length ? 'NOT listening' : owned ? 'listening' : 'listening, NOT ours'
  report(
    '2',
    catalogPort !== undefined &&
      owned &&
      catalogPort === port &&
      models.length > 0 &&
      rowsElsewhere.length === 0 &&
      variants.length > 0 &&
      noBody.length === 0,
    'catalog',
    [
      `baseURL ${String(baseURL)} (${listener} in server pid` +
        `${port && catalogPort !== port ? `, port changed from ${port}` : ''})`,
      `${models.length} kiro models, ${rowsElsewhere.length} rows with another baseURL`,
      `${variants.length - noBody.length}/${variants.length} variants carry body.thinkingConfig.thinkingBudget` +
        noBody
          .slice(0, 3)
          .map(({ model, v }) => `, ${model}#${v.id} ${shape(v)}`)
          .join(''),
      `discovery: ${discovery}`
    ].join('; ')
  )

  // 3. Variant levels match the advertised effort schema.
  const expected = expectedVariants(wire)
  const byId = new Map(models.map((m) => [m.id, ordered((m.variants ?? []).map((v) => v.id))]))
  const mismatches: string[] = []
  for (const [id, levels] of expected) {
    const got = byId.get(id)
    if (!got) mismatches.push(`${id} missing from catalog`)
    else if (got.join('/') !== levels.join('/')) {
      mismatches.push(`${id} expected ${levels.join('/') || 'none'} got ${got.join('/') || 'none'}`)
    }
  }
  const wireIds = new Set(wire.map((w) => toOpenCodeId(w.modelId)))
  for (const id of byId.keys()) {
    if (!wireIds.has(id.replace(/-thinking$/, ''))) mismatches.push(`${id} not in kiro-models.json`)
  }
  const missing = REQUIRED_MODELS.filter((id) => !expected.has(id) || !byId.has(id))
  report(
    '3',
    expected.size > 0 && missing.length === 0 && mismatches.length === 0,
    'variants vs schema',
    `${expected.size} catalog ids compared with kiro-models.json effort levels, ${mismatches.length} mismatches` +
      `${mismatches.length ? ` (${mismatches.slice(0, 5).join('; ')})` : ''}; ` +
      REQUIRED_MODELS.map((id) =>
        expected.has(id) && byId.has(id)
          ? `${id}=${byId.get(id)?.join('/') || 'none'}`
          : `${id}=MISSING`
      ).join(' ')
  )

  // 4. Real completions carry the effort on the wire; 5. runs alongside.
  const completions = await Promise.all(COMPLETIONS.map((spec) => completion(bin, env, spec, wire)))
  for (const c of completions) report(c.id, c.ok, c.title, c.evidence)
  const held = await idle
  report('5', held.open, 'gateway idle', `127.0.0.1:${port ?? '?'} ${held.detail}`)

  // 7 runs last: the rotation closes the old listener, so the idle hold must be over.
  await rotation(bin, env, port, wire)
}

/** 7. Force a gateway rotation whose catalog fold must heal a stale record. */
async function rotation(
  bin: string,
  env: Record<string, string>,
  oldPort: number | undefined,
  wire: WireModel[]
): Promise<void> {
  const fixture = join(runDir, 'stale-kiro')
  mkdirSync(fixture, { recursive: true })
  writeFileSync(join(fixture, 'index.ts'), STALE_FIXTURE)
  writeFileSync(join(fixture, 'package.json'), '{"name":"live-probe-stale-kiro","type":"module"}')
  const seen = new Set(probeRequestLogs().map((l) => l.file))
  const before = ourLogEntries().length
  const began = Date.now()
  writePlugins([fixture, pluginDir])

  // 7a. The old listener stops and a new one is created on another port.
  let lines: string[] = []
  let newPort: number | undefined
  while (Date.now() - began < 30_000 && newPort === undefined) {
    await Bun.sleep(250)
    lines = ourLogEntries()
      .slice(before)
      .map((e) => e.text.replace(/^.*?(INFO|WARN|ERROR): /, '').trim())
    newPort = lines
      .map((line) => gatewayPort(/^Kiro gateway created at (\S+)/.exec(line)?.[1]))
      .find((p) => p !== undefined && p !== oldPort)
  }
  if (newPort) live.ports.add(newPort)
  const stopped = lines.some(
    (line) =>
      line === `Kiro gateway stopped at http://127.0.0.1:${oldPort}` ||
      line.startsWith('Kiro gateway from older plugin code replaced')
  )
  report(
    '7a',
    stopped && newPort !== undefined,
    'rotation',
    `config now loads [fixture, kiro]; plugin.log from server pid within ${secs(Date.now() - began)}: ` +
      (lines.filter((line) => line.startsWith('Kiro gateway')).join(' | ') || 'no gateway lines')
  )

  // 7b. The provider record and every kiro row follow the new port. The
  // fixture's stale record sits ahead of kiro's transform, so only the heal
  // branch can produce this.
  const target = newPort ? `http://127.0.0.1:${newPort}` : undefined
  const onTarget = (models: Model[]) => models.filter((m) => m.settings?.baseURL === target)
  let snapshot = { baseURL: undefined as unknown, models: [] as Model[] }
  const settleBy = Date.now() + 10_000
  while (Date.now() < settleBy) {
    snapshot = { baseURL: await providerBaseURL(), models: await kiroModels() }
    const { baseURL, models } = snapshot
    if (target && baseURL === target && models.length && onTarget(models).length === models.length)
      break
    await Bun.sleep(250)
  }
  const plugins = await waitForPlugin()
  const order = plugins.map((p) => (samePath(p.source?.path, fixture) ? 'fixture' : p.id))
  const fixtureFirst = order.includes('fixture') && order.indexOf('fixture') < order.indexOf('kiro')
  const fixtureActive = plugins.some(
    (p) => samePath(p.source?.path, fixture) && p.state?.status === 'active'
  )
  const kiroState = plugins.find((p) => p.id === 'kiro')?.state?.status ?? 'missing'
  const rows = snapshot.models
  report(
    '7b',
    fixtureActive &&
      fixtureFirst &&
      target !== undefined &&
      snapshot.baseURL === target &&
      rows.length > 0 &&
      onTarget(rows).length === rows.length,
    'rotation heal',
    [
      `stale fixture record ${STALE_URL} ${fixtureActive && fixtureFirst ? 'active ahead of kiro' : 'NOT ahead of kiro'} (kiro ${kiroState})`,
      `provider baseURL now ${String(snapshot.baseURL)} (expected ${target ?? 'a new port'})`,
      `${onTarget(rows).length}/${rows.length} kiro rows on it`
    ].join('; ')
  )

  // 7c. Exactly one gateway listener is left in the server, and the old port is closed.
  const own = serverSockets()
  const gateways = listeners()
    .filter((l) => own.has(l.inode) && l.port !== live.apiPort)
    .map((l) => l.port)
  const oldOpen = oldPort !== undefined && listeners().some((l) => l.port === oldPort)
  report(
    '7c',
    gateways.length === 1 && gateways[0] === newPort && !oldOpen,
    'rotation listeners',
    `server pid listens on ${gateways.join(', ') || 'no'} gateway port(s) besides API port ` +
      `${live.apiPort}; old port ${oldPort ?? '?'} ${oldOpen ? 'STILL LISTENING' : 'closed'}`
  )

  // 7d. A completion still works after the rotation.
  if (!newPort) {
    report('7d', false, 'completion after rotation', 'skipped: no rotation happened')
    return
  }
  const after = await completion(bin, env, AFTER_ROTATION, wire, seen)
  report(after.id, after.ok, `${after.title} after rotation`, after.evidence)
}

/** 4. Run one completion and find its new request log with the expected effort. */
async function completion(
  bin: string,
  env: Record<string, string>,
  spec: { id: string; model: string; variant: string },
  wire: WireModel[],
  seen = new Set<string>()
): Promise<{ id: string; ok: boolean; title: string; evidence: string }> {
  const title = `completion kiro/${spec.model}#${spec.variant}`
  const w = wire.find((m) => toOpenCodeId(m.modelId) === spec.model)
  if (!w?.effort?.field) {
    return { id: spec.id, ok: false, title, evidence: `no effort schema in kiro-models.json` }
  }
  const expected = JSON.stringify({ [w.effort.field]: { effort: spec.variant } })
  const began = Date.now()
  // --title skips the title request; it would carry the lowest variant (`low`)
  // and could stand in for a main request that lost its effort.
  const proc = Bun.spawn(
    [bin, 'run', '--server', live.url ?? '', '--archived', '--title', 'live-probe'].concat([
      '-m',
      `kiro/${spec.model}#${spec.variant}`,
      prompt
    ]),
    { cwd: workDir, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' }
  )
  live.children.add(proc)
  const timer = setTimeout(() => killOurs(proc.pid, 'SIGKILL'), 180_000)
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited
  ])
  clearTimeout(timer)
  live.children.delete(proc)
  const reply = stripAnsi(out).trim()
  const logs = probeRequestLogs().filter((l) => !seen.has(l.file) && l.model === w.modelId)
  const hit = logs.find((l) => l.fields === expected)
  const ok = code === 0 && /\bOK\b/.test(reply) && hit !== undefined
  const tail = stripAnsi(err).trim().split('\n').slice(-3).join(' | ')
  const evidence = [
    `reply ${JSON.stringify(reply.slice(0, 80))} (exit ${code}, ${secs(Date.now() - began)})`,
    `expected ${expected}`,
    `${w.modelId} request logs: ${logs.map((l) => `${l.file} ${l.fields}`).join(', ') || 'none'}`,
    ...(!ok && tail ? [`stderr: ${tail}`] : [])
  ]
  return { id: spec.id, ok, title, evidence: evidence.join('; ') }
}

async function startServer(bin: string, env: Record<string, string>): Promise<void> {
  const stderr = openSync(join(runDir, 'server.stderr.log'), 'w')
  // --stdio: the ready line is JSON on stdout, and the server exits when its
  // stdin closes, so a crashed probe cannot leave it running.
  const proc = Bun.spawn([bin, 'serve', '--stdio', '--hostname', '127.0.0.1', '--port', '0'], {
    cwd: workDir,
    env,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr
  })
  closeSync(stderr)
  live.server = proc
  live.pids.add(proc.pid)
  // Keep draining stdout after the ready line so later writes cannot hit EPIPE.
  const ready = new Promise<string>((done, fail) => {
    void (async () => {
      const reader = proc.stdout.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let sent = false
      for (;;) {
        const { value, done: finished } = await reader.read()
        if (finished) break
        if (sent) continue
        buffer += decoder.decode(value, { stream: true })
        const end = buffer.indexOf('\n')
        if (end >= 0) {
          sent = true
          done(buffer.slice(0, end))
        }
      }
      if (!sent) fail(new Error(`server exited before reporting readiness: ${stderrTail()}`))
    })().catch(fail)
  })
  const line = await withTimeout(ready, 30_000, 'server readiness')
  const url = (JSON.parse(line) as { url?: unknown }).url
  if (typeof url !== 'string') throw new Error(`unexpected ready line: ${line.slice(0, 200)}`)
  live.url = url
  live.apiPort = gatewayPort(url)
  if (live.apiPort) live.ports.add(live.apiPort)
}

/** The private server's only config: these plugin dirs, in this order. */
function writePlugins(dirs: string[]): void {
  const plugins = dirs.map((dir) => ({ package: dir }))
  writeFileSync(join(runDir, 'config', 'opencode.json'), JSON.stringify({ plugins }, null, 2))
}

async function api(path: string): Promise<{ status: number; body: unknown }> {
  const sep = path.includes('?') ? '&' : '?'
  const res = await fetch(
    `${live.url}${path}${sep}location[directory]=${encodeURIComponent(workDir)}`,
    { headers: { authorization: auth }, signal: AbortSignal.timeout(15_000) }
  )
  return { status: res.status, body: await res.json().catch(() => null) }
}

function dataOf(body: unknown): unknown {
  return body && typeof body === 'object' && 'data' in body
    ? (body as { data: unknown }).data
    : body
}

/** /api/plugin is lazy: poll until this plugin settles (active or failed). */
async function waitForPlugin(): Promise<PluginInfo[]> {
  const deadline = Date.now() + 60_000
  let list: PluginInfo[] = []
  while (Date.now() < deadline) {
    const data = dataOf((await api('/api/plugin')).body)
    list = Array.isArray(data) ? (data as PluginInfo[]) : []
    const ours = list.find((p) => p.id === 'kiro' || samePath(p.source?.path, pluginDir))
    if (ours?.state?.status) return list
    await Bun.sleep(250)
  }
  return list
}

async function configSources(): Promise<string[]> {
  const data = dataOf((await api('/api/config')).body)
  return Array.isArray(data)
    ? data.flatMap((s) => (typeof s?.path === 'string' ? [s.path as string] : []))
    : []
}

async function providerBaseURL(): Promise<unknown> {
  const data = dataOf((await api('/api/provider/kiro')).body) as {
    settings?: { baseURL?: unknown }
  }
  return data?.settings?.baseURL
}

async function waitForGatewayPort(): Promise<number | undefined> {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const port = gatewayPort(await providerBaseURL())
    if (port) return port
    await Bun.sleep(250)
  }
  return undefined
}

async function kiroModels(): Promise<Model[]> {
  const data = dataOf((await api('/api/model')).body)
  return Array.isArray(data) ? (data as Model[]).filter((m) => m.providerID === 'kiro') : []
}

/** Wait for the server pid's discovery result line (success or kept cache). */
async function waitForDiscovery(): Promise<string> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const line = ourLogEntries().find((e) =>
      /Kiro model discovery: \d+|Kiro model discovery failed; keeping/.test(e.text)
    )
    if (line) return line.text.replace(/^.*?(INFO|WARN): /, '').split('\n')[0] ?? ''
    await Bun.sleep(250)
  }
  return 'no result line within 30 s (catalog from cache)'
}

/** Read provider + models until two reads 500 ms apart agree (the reload has landed). */
async function stableCatalog(): Promise<{ baseURL: unknown; models: Model[] }> {
  let previous = ''
  let snapshot = { baseURL: undefined as unknown, models: [] as Model[] }
  for (let i = 0; i < 10; i++) {
    snapshot = { baseURL: await providerBaseURL(), models: await kiroModels() }
    const signature = JSON.stringify(snapshot)
    if (signature === previous) break
    previous = signature
    await Bun.sleep(500)
  }
  return snapshot
}

function readWireModels(): WireModel[] {
  const file = join(kiroDir, 'kiro-models.json')
  const models = attempt(() => JSON.parse(readFileSync(file, 'utf8')).models as unknown, [])
  return Array.isArray(models)
    ? (models as WireModel[]).filter((m) => typeof m?.modelId === 'string')
    : []
}

/** Catalog id -> effort levels, per the schema cached by the plugin. */
function expectedVariants(wire: WireModel[]): Map<string, string[]> {
  const expected = new Map<string, string[]>()
  for (const w of wire) {
    if (w.effort === undefined) continue // cache written before the plugin read the schema
    const levels = ordered(w.effort?.levels ?? [])
    const id = toOpenCodeId(w.modelId)
    expected.set(id, levels)
    if (levels.length > 0 && w.modelId.startsWith('claude-')) expected.set(`${id}-thinking`, levels)
  }
  return expected
}

/** The plugin's id rule, restated so a broken rule in the plugin cannot hide here. */
function toOpenCodeId(wireId: string): string {
  return wireId.startsWith('claude-') ? wireId.replace(/\./g, '-') : wireId
}

function ordered(levels: string[]): string[] {
  const rank = (l: string) => (EFFORT_LEVELS.includes(l) ? EFFORT_LEVELS.indexOf(l) : 99)
  return [...levels].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
}

function thinkingBudget(body: Record<string, unknown> | undefined): unknown {
  const config = body?.thinkingConfig as { thinkingBudget?: unknown } | undefined
  return config?.thinkingBudget
}

function shape(v: Variant): string {
  const keys = (o: Record<string, unknown> | undefined) => Object.keys(o ?? {}).join('+') || '-'
  return `{settings: ${keys(v.settings)}, body: ${keys(v.body)}}`
}

/** 5. Announce a body that never arrives and watch whether the gateway hangs up. */
function idleHold(port: number): Promise<{ open: boolean; detail: string }> {
  return new Promise((done) => {
    const opened = Date.now()
    let closed: string | undefined
    let received = 0
    const socket = connect({ host: '127.0.0.1', port })
    live.sockets.add(socket)
    const mark = (why: string) => {
      closed ??= `${why} after ${secs(Date.now() - opened)}`
    }
    socket.on('connect', () =>
      socket.write(
        'POST /chat/completions HTTP/1.1\r\nHost: 127.0.0.1\r\n' +
          'Content-Type: application/json\r\nContent-Length: 64\r\n\r\n'
      )
    )
    socket.on('data', (chunk) => {
      received += chunk.length
    })
    socket.on('end', () => mark('server ended the connection'))
    socket.on('close', () => mark('connection closed'))
    socket.on('error', (e) => mark(`socket error ${e.message}`))
    setTimeout(() => {
      const open = closed === undefined && !socket.destroyed
      socket.destroy()
      live.sockets.delete(socket)
      done({
        open,
        detail: `${open ? `still open after ${secs(IDLE_HOLD_MS)}` : closed} (${received} bytes received)`
      })
    }, IDLE_HOLD_MS)
  })
}

/** Request logs written since the probe started whose prompt carries this run's nonce. */
function probeRequestLogs(): Array<{
  file: string
  stamp: string
  model?: string
  fields: string
}> {
  return listDir(logDir)
    .filter((f) => !logsBefore.has(f) && f.endsWith('_request.json'))
    .sort()
    .flatMap((file) => {
      const stamp = API_LOG.exec(file)?.[1]
      const text = attempt(() => readFileSync(join(logDir, file), 'utf8'), '')
      if (!stamp || !text.includes(nonce)) return []
      const json = attempt(
        () => JSON.parse(text) as { model?: string; body?: Record<string, unknown> },
        {}
      )
      const fields = JSON.stringify(json.body?.additionalModelRequestFields ?? null)
      return [{ file, stamp, model: json.model, fields }]
    })
}

/** plugin.log entries appended since the probe started, from the server's pid. */
function ourLogEntries(): LogEntry[] {
  const text = attempt(() => {
    const size = fileSize(pluginLog)
    const from = size < logStart ? 0 : logStart // truncated meanwhile: read it all
    const fd = openSync(pluginLog, 'r')
    const buffer = Buffer.alloc(size - from)
    readSync(fd, buffer, 0, buffer.length, from)
    closeSync(fd)
    return buffer.toString('utf8')
  }, '')
  return text.split(/\n(?=\[\d{4}-\d{2}-\d{2}T)/).flatMap((chunk) => {
    const m = /^\[[^\]]+\] \[pid (\d+)\] (\w+): /.exec(chunk)
    if (!m || !live.pids.has(Number(m[1]))) return []
    return [{ pid: Number(m[1]), level: m[2] ?? '', text: chunk.trimEnd() }]
  })
}

function childEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value
  // Anything that could add config or a credential from the caller's shell.
  for (const key of [
    'OPENCODE_CONFIG',
    'OPENCODE_CONFIG_CONTENT',
    'OPENCODE_SERVER_PASSWORD',
    'OPENCODE_DISABLE_PROJECT_CONFIG'
  ]) {
    delete env[key]
  }
  return {
    ...env,
    OPENCODE_PASSWORD: password,
    OPENCODE_CONFIG_DIR: join(runDir, 'config'),
    OPENCODE_CONFIG_PROJECT_DISABLE: '1',
    XDG_DATA_HOME: join(runDir, 'data'),
    XDG_STATE_HOME: join(runDir, 'state'),
    XDG_CACHE_HOME: join(runDir, 'cache'),
    KIRO_ENABLE_LOG_API_REQUEST: 'true',
    // `opencode run` takes its directory from $PWD before cwd().
    PWD: workDir
  }
}

async function cleanup(): Promise<string[]> {
  const notes: string[] = []
  for (const socket of live.sockets) socket.destroy()
  for (const child of live.children) killOurs(child.pid, 'SIGKILL')
  const server = live.server
  if (server) {
    attempt(() => server.stdin.end(), 0) // ends the --stdio lease
    let how = 'exited after its stdin closed'
    if (!(await exitedWithin(server, 10_000))) {
      how = killOurs(server.pid, 'SIGTERM')
        ? 'stopped with SIGTERM'
        : 'not killed (cwd check failed)'
      if (!(await exitedWithin(server, 3_000)) && killOurs(server.pid, 'SIGKILL')) how = 'killed'
    }
    notes.push(`server pid ${server.pid} ${how} (exit ${server.exitCode ?? server.signalCode})`)
    // 6. Evaluated after shutdown so teardown lines count too.
    const entries = ourLogEntries()
    const locks = entries.filter((e) => /Lock file is already being held/.test(e.text))
    const errors = entries.filter((e) => e.level === 'ERROR')
    const offenders = [...new Set([...locks, ...errors])].map((e) => e.text.split('\n')[0])
    report(
      '6',
      entries.length > 0 && offenders.length === 0,
      'plugin.log',
      [
        `${entries.length} entries from server pid since probe start`,
        `${locks.length} lock-contention, ${errors.length} ERROR`,
        ...offenders.slice(0, 5).map((line) => line?.slice(0, 200))
      ].join('; ')
    )
  }
  for (const pid of strays()) {
    if (killOurs(pid, 'SIGKILL')) notes.push(`killed stray pid ${pid}`)
  }
  const busy = [...live.ports].filter((port) => listeners().some((l) => l.port === port))
  if (busy.length) report('cleanup', false, 'ports', `still listening: ${busy.join(', ')}`)
  else notes.push(`ports ${[...live.ports].join(', ') || 'none'} free`)
  // Delete only the logs of requests this probe caused: the request carries the
  // nonce, and its response shares the request's timestamp.
  const stamps = new Set(probeRequestLogs().map((l) => l.stamp))
  const ours = listDir(logDir).filter((file) => {
    const stamp = API_LOG.exec(file)?.[1]
    const path = join(logDir, file)
    return (
      !!stamp && stamps.has(stamp) && !logsBefore.has(file) && fileMtime(path) >= started - 1000
    )
  })
  const deleted = ours.filter((file) =>
    attempt(() => (unlinkSync(join(logDir, file)), true), false)
  )
  notes.push(
    `deleted ${deleted.length} API log file(s) from this probe's ${stamps.size} request(s)`
  )
  return notes
}

async function exitedWithin(proc: Subprocess, ms: number): Promise<boolean> {
  return Promise.race([proc.exited.then(() => true), Bun.sleep(ms).then(() => false)])
}

/** Signal a pid only if /proc shows it belongs to this run (cwd or argv inside the run dir). */
function killOurs(pid: number, signal: NodeJS.Signals): boolean {
  return belongsToRun(pid) && attempt(() => process.kill(pid, signal), false)
}

function belongsToRun(pid: number): boolean {
  const cwd = attempt(() => readlinkSync(`/proc/${pid}/cwd`), '')
  const argv = attempt(() => readFileSync(`/proc/${pid}/cmdline`, 'utf8'), '')
  return cwd === runDir || cwd.startsWith(`${runDir}/`) || argv.includes(runDir)
}

/** Processes still running inside the run dir (e.g. a helper the server spawned). */
function strays(): number[] {
  return listDir('/proc')
    .filter((d) => /^\d+$/.test(d))
    .map(Number)
    .filter((pid) => pid !== process.pid && belongsToRun(pid))
}

/** LISTEN sockets on this host: local TCP port and socket inode (/proc/net/tcp{,6}). */
function listeners(): Array<{ port: number; inode: string }> {
  const rows: Array<{ port: number; inode: string }> = []
  for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) {
    for (const line of attempt(() => readFileSync(table, 'utf8'), '')
      .split('\n')
      .slice(1)) {
      const cols = line.trim().split(/\s+/)
      const local = cols[1]
      if (!local || cols[3] !== '0A' || !cols[9]) continue
      rows.push({ port: parseInt(local.split(':').pop() ?? '', 16), inode: cols[9] })
    }
  }
  return rows
}

/** Socket inodes held open by the server process. */
function serverSockets(): Set<string> {
  const inodes = new Set<string>()
  for (const pid of live.pids) {
    for (const fd of listDir(`/proc/${pid}/fd`)) {
      const link = attempt(() => readlinkSync(`/proc/${pid}/fd/${fd}`), '')
      if (link.startsWith('socket:[')) inodes.add(link.slice('socket:['.length, -1))
    }
  }
  return inodes
}

function gatewayPort(url: unknown): number | undefined {
  const m = typeof url === 'string' ? /^http:\/\/127\.0\.0\.1:(\d+)\/?$/.exec(url) : null
  const port = m ? Number(m[1]) : 0
  return port > 0 ? port : undefined
}

function samePath(a: string | undefined, b: string): boolean {
  return a !== undefined && attempt(() => realpathSync(a) === realpathSync(b), a === b)
}

function gitState(dir: string): string {
  const head = Bun.spawnSync(['git', '-C', dir, 'rev-parse', '--short', 'HEAD'], {
    stderr: 'ignore'
  })
  if (head.exitCode !== 0) return 'not a git checkout'
  const status = Bun.spawnSync(
    ['git', '--no-optional-locks', '-C', dir, 'status', '--porcelain', '--untracked-files=no'],
    { stderr: 'ignore' }
  )
  const changed = status.stdout.toString().split('\n').filter(Boolean).length
  return `git ${head.stdout.toString().trim()}${changed ? ` + ${changed} modified file(s)` : ', clean'}`
}

function parseArgs(argv: string[]): string {
  let dir = resolve(import.meta.dir, '..')
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? ''
    if (arg === '--plugin-dir') dir = argv[++i] ?? ''
    else if (arg.startsWith('--plugin-dir=')) dir = arg.slice('--plugin-dir='.length)
    else if (arg === '-h' || arg === '--help') {
      console.log('usage: bun scripts/live-probe.ts [--plugin-dir <abs path>]')
      process.exit(0)
    } else {
      console.error(`unknown argument: ${arg}`)
      process.exit(2)
    }
  }
  if (
    !isAbsolute(dir) ||
    !existsSync(join(dir, 'index.ts')) ||
    !existsSync(join(dir, 'package.json'))
  ) {
    console.error(
      `--plugin-dir must be an absolute plugin directory with index.ts and package.json: ${dir}`
    )
    process.exit(2)
  }
  return realpathSync(dir)
}

function report(id: string, ok: boolean, title: string, evidence: string): void {
  if (verdict) return // an interrupted main() still unwinding
  results.push({ id, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id} ${title}: ${redact(evidence)}`)
}

/** Never print emails, tokens, ARNs, URL credentials or query strings. */
function redact(text: string): string {
  return text
    .replace(/(\w+:\/\/)[^\s/@"']+@/g, '$1<redacted>@')
    .replace(/(https?:\/\/[^\s"'?#]+)\?[^\s"']*/g, '$1?<redacted>')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer <redacted>')
    .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, '<token>')
    .replace(/arn:aws:[^\s"',;)]+/g, '<arn>')
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
}

function stderrTail(): string {
  const text = attempt(() => readFileSync(join(runDir, 'server.stderr.log'), 'utf8'), '')
  return text.trim().split('\n').slice(-3).join(' | ') || 'no stderr'
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    Bun.sleep(ms).then(() => {
      throw new Error(`${label} timed out after ${secs(ms)}`)
    })
  ])
}

/** Run a read that may fail (a vanished pid, fd or file) with a fallback. */
function attempt<T>(read: () => T, fallback: T): T {
  try {
    return read()
  } catch {
    return fallback
  }
}

function listDir(dir: string): string[] {
  return attempt(() => readdirSync(dir), [] as string[])
}

function fileSize(path: string): number {
  return attempt(() => statSync(path).size, 0)
}

function fileMtime(path: string): number {
  return attempt(() => statSync(path).mtimeMs, 0)
}

function secs(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`
}
