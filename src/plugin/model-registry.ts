import type { WireModel } from './available-models.js'
import { EFFORT_LEVELS, supportsEffort, supportsXHighEffort, THINKING_BUDGETS } from './effort.js'
import { registerModelPair } from './models.js'

type Modalities = {
  input: Array<'text' | 'image' | 'pdf'>
  output: ['text']
}

const TEXT_ONLY: Modalities = { input: ['text'], output: ['text'] }
const TEXT_IMAGE: Modalities = { input: ['text', 'image'], output: ['text'] }
const MULTIMODAL: Modalities = { input: ['text', 'image', 'pdf'], output: ['text'] }

const CONTEXT_200K = { context: 200000, output: 64000 }

/**
 * OpenCode-facing ID for a Kiro wire ID. Claude models keep the established
 * dash form (`claude-opus-4.5` -> `claude-opus-4-5`, matching existing user
 * configs); every other family uses its wire ID unchanged (`gpt-5.6-sol`,
 * `deepseek-3.2`). This is a spelling rule over API data, not a model list.
 */
export function toOpenCodeModelId(wireId: string): string {
  return wireId.startsWith('claude-') ? wireId.replace(/\./g, '-') : wireId
}

function modalitiesFor(wireId: string): Modalities {
  if (wireId.startsWith('claude-')) return MULTIMODAL
  if (wireId.startsWith('gpt-') || wireId.startsWith('kimi-')) return TEXT_IMAGE
  return TEXT_ONLY
}

/**
 * Build the thinking variants a model supports.
 *
 * Levels come from the model's own effort capabilities, so xhigh only appears on
 * models that accept it and the budgets stay in step with budgetToEffort.
 */
function buildVariants(kiroModel: string): Record<string, unknown> {
  const variants: Record<string, unknown> = {}

  for (const level of EFFORT_LEVELS) {
    if (level === 'xhigh' && !supportsXHighEffort(kiroModel)) continue
    variants[level] = { thinkingConfig: { thinkingBudget: THINKING_BUDGETS[level] } }
  }

  return variants
}

/**
 * Model registry advertised to OpenCode, generated from the account's
 * ListAvailableModels data (live fetch or the last-good cache). Every entry
 * also registers its OpenCode ID -> wire ID pair for request resolution.
 *
 * `-thinking` entries carry `reasoning` and `interleaved`. Both are required:
 * `reasoning` declares the capability, and `interleaved.field` tells OpenCode
 * that reasoning arrives in the non-standard `reasoning_content` delta this
 * plugin emits (see streaming/openai-converter.ts). Without them OpenCode
 * silently drops every reasoning chunk and no thinking block is rendered.
 * Thinking companions are emitted for effort-capable Claude models (version
 * rule in effort.ts).
 */
export function buildModelRegistry(wireModels: WireModel[]): Record<string, unknown> {
  const models: Record<string, unknown> = {}

  for (const wire of wireModels) {
    const modelID = toOpenCodeModelId(wire.modelId)
    const limit = {
      context: wire.maxInputTokens ?? CONTEXT_200K.context,
      output: wire.maxOutputTokens ?? CONTEXT_200K.output
    }
    const modalities = modalitiesFor(wire.modelId)
    const baseName = wire.modelName ?? wire.modelId
    const name =
      wire.rateMultiplier !== undefined ? `${baseName} (${wire.rateMultiplier}x)` : baseName

    registerModelPair(modelID, wire.modelId, limit.context)

    if (!supportsEffort(wire.modelId)) {
      models[modelID] = { name, limit, modalities }
      continue
    }

    // Effort variants live on the base model too: picking one sends
    // thinkingConfig, which the request handler treats as thinking enabled
    // (same signal as the -thinking twin). No variant = no thinking.
    const variants = buildVariants(wire.modelId)
    models[modelID] = { name, limit, modalities, variants }

    const thinkingID = `${modelID}-thinking`
    models[thinkingID] = {
      name: `${baseName} Thinking${wire.rateMultiplier !== undefined ? ` (${wire.rateMultiplier}x)` : ''}`,
      limit,
      modalities,
      reasoning: true,
      interleaved: { field: 'reasoning_content' },
      variants
    }
    registerModelPair(thinkingID, wire.modelId, limit.context)
  }

  return models
}
