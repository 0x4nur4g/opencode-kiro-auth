import type { WireModel } from '../plugin/available-models.js'
import { buildModelRegistry } from '../plugin/model-registry.js'
import type { ModelInfoDraft, PluginContext, Registration } from './host-types.js'

/**
 * Register the Kiro provider plus its model catalog in one transform.
 *
 * The transform replays very often, so the body is signature-guarded: it writes
 * only when the gateway URL or the model ID list actually changed. Two failure
 * modes shaped this:
 *
 * - A stopped gateway reports port 0. Writing that URL poisons the provider
 *   record (`http://127.0.0.1:0`); every model call then fails ECONNREFUSED
 *   while the real gateway listens elsewhere. A dead gateway writes nothing.
 * - The gateway rotates to a new port on host reload. An existing provider
 *   record must be updated to the live URL, not left pointing at the old port.
 *
 * If the provider ID already exists with a different package (user config,
 * another plugin) it is left untouched, so the user's own provider block wins.
 */
export function registerKiroCatalog(
  ctx: PluginContext,
  opts: {
    providerID: string
    gatewayUrl: () => string
    gatewayLive: () => boolean
    getModels: () => Array<ModelInfoDraft>
  }
): Promise<Registration> {
  let appliedSignature = ''
  return ctx.provider.transform((draft) => {
    if (!opts.gatewayLive()) return
    const baseURL = opts.gatewayUrl()
    const models = opts.getModels()
    const signature = `${baseURL}|${models.map((m) => m.id).join(',')}`
    // Host shape (core/src/provider.ts editor.get): a ProviderRecord
    // `{ provider, models, sourceConnection }`, NOT the Provider.Info itself.
    // Reading .package/.settings off the record silently yields undefined and
    // disables the update branch below — that shipped once and left the
    // catalog pointing at a dead gateway port after rotation.
    const record = draft.get(opts.providerID) as
      | {
          provider?: { package?: unknown; settings?: { baseURL?: unknown } }
          package?: unknown
          settings?: { baseURL?: unknown }
        }
      | undefined
    if (!record) {
      draft.add({
        info: {
          id: opts.providerID,
          name: 'Kiro',
          activation: 'enabled',
          package: '@opencode/ai/providers/openai-compatible',
          settings: { baseURL }
        },
        models
      })
      appliedSignature = signature
      return
    }
    const existing = record.provider ?? record
    if (existing.package !== '@opencode/ai/providers/openai-compatible') return
    // Only ever repoint a loopback URL: that is this plugin's gateway shape.
    // A non-loopback baseURL means a user-owned provider block; leave it alone.
    const existingBase = existing.settings?.baseURL
    if (typeof existingBase === 'string' && !existingBase.startsWith('http://127.0.0.1')) return
    if (signature === appliedSignature && existingBase === baseURL) return
    draft.update(opts.providerID, (provider) => {
      provider.settings = { ...(provider.settings ?? {}), baseURL }
    })
    draft.models.set(opts.providerID, models)
    appliedSignature = signature
  })
}

/**
 * Map the V1 model registry onto V2 ModelInfoDraft entries.
 *
 * V1 entries are `Record<string, unknown>` at the type level, so every field is
 * read defensively; anything non-JSON in the variant settings is stripped by a
 * JSON round-trip. `settings.apiKey` is a non-secret placeholder required by the
 * openai-compatible factory — never a credential.
 */
export function buildV2ModelRegistry(
  providerID: string,
  wireModels: WireModel[]
): Array<ModelInfoDraft> {
  const registry = buildModelRegistry(wireModels)
  const models: Array<ModelInfoDraft> = []

  for (const [modelID, raw] of Object.entries(registry)) {
    const spec = raw as {
      name?: unknown
      limit?: { context?: unknown; output?: unknown }
      modalities?: { input?: unknown }
      variants?: unknown
      interleaved?: { field?: unknown }
    }

    const reasoningField = stringOf(spec.interleaved?.field)
    const record: ModelInfoDraft = {
      id: modelID,
      modelID,
      providerID,
      name: typeof spec.name === 'string' ? spec.name : modelID,
      status: 'active',
      enabled: true,
      capabilities: {
        tools: true,
        input: toStringArray(spec.modalities?.input) ?? ['text'],
        output: ['text']
      },
      limit: {
        context: toNumber(spec.limit?.context) ?? 200000,
        output: toNumber(spec.limit?.output) ?? 32000
      },
      variants: toVariants(spec.variants),
      time: { released: 0 },
      cost: [],
      settings: { apiKey: 'kiro-gateway' }
    }

    // V2 spells the V1 `interleaved.field` as `compatibility.reasoningField`;
    // without it the runtime drops non-standard reasoning deltas.
    if (reasoningField) record.compatibility = { reasoningField }

    models.push(record)
  }

  return models
}

function toStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const result = value.filter((entry): entry is string => typeof entry === 'string')
  return result.length > 0 ? result : undefined
}

function toNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function toVariants(value: unknown): Array<{ id: string; settings?: Record<string, unknown> }> {
  if (typeof value !== 'object' || value === null) return []

  const variants: Array<{ id: string; settings?: Record<string, unknown> }> = []
  for (const [id, settings] of Object.entries(value)) {
    variants.push({ id, settings: stripToJson(settings) })
  }
  return variants
}

function stripToJson(value: unknown): Record<string, unknown> | undefined {
  try {
    const clone = JSON.parse(JSON.stringify(value))
    if (typeof clone === 'object' && clone !== null && !Array.isArray(clone)) {
      return clone as Record<string, unknown>
    }
    return undefined
  } catch {
    return undefined
  }
}
