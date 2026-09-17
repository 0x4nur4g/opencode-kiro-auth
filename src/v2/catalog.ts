import { buildModelRegistry } from '../plugin/model-registry.js'
import type { ModelInfoDraft, PluginContext, Registration } from './host-types.js'

/**
 * Register the Kiro provider plus its model catalog in one transform.
 *
 * One-shot: if the provider ID already exists (user config, another plugin, a
 * duplicated setup run) nothing is added, so the user's own provider block wins.
 */
export function registerKiroCatalog(
  ctx: PluginContext,
  opts: { providerID: string; gatewayUrl: () => string; models: Array<ModelInfoDraft> }
): Promise<Registration> {
  return ctx.provider.transform((draft) => {
    if (draft.get(opts.providerID)) return
    draft.add({
      info: {
        id: opts.providerID,
        name: 'Kiro',
        activation: 'enabled',
        package: '@opencode/ai/providers/openai-compatible',
        settings: { baseURL: opts.gatewayUrl() }
      },
      models: opts.models
    })
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
export function buildV2ModelRegistry(providerID: string): Array<ModelInfoDraft> {
  const registry = buildModelRegistry()
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
