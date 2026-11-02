import type { RequestHandler } from '../core/request/request-handler.js'

export type NotifyFn = (message: string, variant: 'info' | 'success' | 'warn' | 'error') => void

/**
 * Loopback OpenAI-compatible endpoint fronting the Kiro request pipeline.
 *
 * OpenCode's provider calls `settings.baseURL + /chat/completions` with its own
 * fetch; the gateway receives that call and routes it through the upstream
 * RequestHandler. The request URL is rewritten to the Kiro region form so the
 * upstream URL-pattern gate and model extraction keep working unchanged.
 */
export class KiroGateway {
  private server: ReturnType<typeof Bun.serve> | undefined
  private port = 0
  private region: string
  private handler: RequestHandler
  private notify: NotifyFn
  /** Token of the `setup` run that currently owns this listener. */
  private owner: symbol | undefined

  constructor(handler: RequestHandler, notify: NotifyFn, region: string) {
    this.handler = handler
    this.notify = notify
    this.region = region
  }

  /**
   * Take ownership for the calling `setup` run and re-point the shared listener
   * at this run's handler. `setup` may run more than once per process (hot
   * reload / duplicate registration); the returned token lets each run release
   * only its own claim.
   */
  claim(handler: RequestHandler, notify: NotifyFn, region: string): symbol {
    this.handler = handler
    this.notify = notify
    this.region = region
    const token = Symbol('kiro-gateway-owner')
    this.owner = token
    return token
  }

  /**
   * Drop ownership. Stops the listener only when this token is still the
   * current owner, so a stale `setup` teardown cannot kill a live gateway.
   * Returns true when this call stopped the listener.
   */
  release(token: symbol): boolean {
    if (this.owner !== token) return false
    this.owner = undefined
    this.stop()
    return true
  }

  async start(): Promise<void> {
    if (this.server) return
    this.server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: (request) => this.dispatch(request)
    })
    this.port = this.server.port ?? 0
  }

  url(): string {
    return `http://127.0.0.1:${this.port}`
  }

  /** True while the listener is bound. `url()` is meaningless otherwise (port 0). */
  isLive(): boolean {
    return this.server !== undefined && this.port > 0
  }

  stop(): void {
    if (this.server) {
      try {
        this.notify(`Kiro gateway stopped at ${this.url()}`, 'info')
      } catch {
        /* lifecycle notify must never break teardown */
      }
    }
    try {
      this.server?.stop(true)
    } catch {
      // ignore stop failures during teardown
    }
    this.server = undefined
    this.port = 0
  }

  private async dispatch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname
    if (request.method === 'POST' && path === '/chat/completions') {
      const body = await request.text()
      const upstreamUrl = `https://q.${this.region}.amazonaws.com/chat/completions`
      try {
        return await this.handler.handle(
          upstreamUrl,
          { method: 'POST', body },
          (message, variant) => this.notify(message, normalizeVariant(variant))
        )
      } catch (error) {
        return errorStream(modelOf(body), error instanceof Error ? error.message : String(error))
      }
    }
    return errorResponse(404, `Not found: ${path}`)
  }
}

/**
 * Failure path for `/chat/completions`.
 *
 * The runtime retries any SSE stream that ends without a terminating
 * `finish_reason` chunk (observed: 5 attempts) and shows a plain HTTP error as
 * an opaque provider failure. Emitting a one-delta SSE completion keeps the
 * response well-formed, terminates the stream, and puts the actionable message
 * (e.g. the `opencode auth login` hint) in front of the user instead.
 */
function errorStream(model: string, message: string): Response {
  const created = Math.floor(Date.now() / 1000)
  const id = `kiro-error-${created}`
  const base = { id, object: 'chat.completion.chunk', created, model }
  const events = [
    {
      ...base,
      choices: [
        {
          index: 0,
          delta: { role: 'assistant', content: `Kiro: ${sanitizeMessage(message)}` },
          finish_reason: null
        }
      ]
    },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }
  ]
  const payload = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')
  return new Response(payload, { headers: { 'Content-Type': 'text/event-stream' } })
}

/** Best-effort model id from the request body, used for the error chunk. */
function modelOf(body: string): string {
  try {
    const parsed = JSON.parse(body) as { model?: unknown }
    if (typeof parsed.model === 'string' && parsed.model) return parsed.model
  } catch {
    /* non-JSON body: fall through to the provider id */
  }
  return 'kiro'
}

/**
 * Redact credential-shaped substrings before a failure message reaches a client
 * or a log line. Never emit a raw Bearer token or JWT-ish blob.
 */
function sanitizeMessage(message: string): string {
  return message
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer <redacted>')
    .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, '<redacted-token>')
    .slice(0, 2000)
}

/**
 * Upstream `ToastFunction` uses `'warning'`; this plugin's NotifyFn uses `'warn'`.
 */
function normalizeVariant(variant: string): 'info' | 'success' | 'warn' | 'error' {
  if (variant === 'warning') return 'warn'
  if (variant === 'info' || variant === 'success' || variant === 'error') return variant
  return 'info'
}

function errorResponse(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { message, type: 'invalid_request_error' } }), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

/**
 * Shared-listener guard: a duplicated `setup` run reuses the same listener
 * instead of binding a second loopback port.
 *
 * The host re-evaluates the plugin module on hot reload, so a module-scope
 * binding resets to `undefined` in every fresh module instance: the `reused`
 * branch never fired and each reload bound another loopback server (live log,
 * 2026-09-21: 19 `created`, 0 `reused`, two servers co-listening 2h21m). Anchor
 * the gateway on the process global via `Symbol.for`, which resolves to the
 * same key in every module instance of this process.
 */
const SHARED_GATEWAY_KEY = Symbol.for('kiro-auth-v2.sharedGateway')

/** Typed symbol-indexed view of the process global; keeps the anchor `any`-free. */
type GatewayAnchor = Record<symbol, KiroGateway | undefined>

function gatewayAnchor(): GatewayAnchor {
  return globalThis as unknown as GatewayAnchor
}

export function getSharedGateway(): KiroGateway | undefined {
  return gatewayAnchor()[SHARED_GATEWAY_KEY]
}

export function setSharedGateway(gateway: KiroGateway | undefined): void {
  gatewayAnchor()[SHARED_GATEWAY_KEY] = gateway
}
