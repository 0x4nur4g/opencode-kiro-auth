import type { Effort } from './config/schema'

/**
 * Effort levels ordered from lowest to highest reasoning depth.
 */
export const EFFORT_LEVELS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'] as const

/**
 * Reference thinking budget for each effort level.
 *
 * Scaled to Kiro's real thinking range (1024–128000 on opus-4.8/opus-5) rather
 * than OpenCode's conventional 32768 cap, so every effort level is reachable
 * from a budget alone. These double as the upper bound of each mapping band in
 * budgetToEffort, and as the variant budgets the plugin advertises, so the two
 * cannot drift apart.
 */
export const THINKING_BUDGETS: Readonly<Record<Effort, number>> = {
  low: 16384,
  medium: 32768,
  high: 65536,
  xhigh: 98304,
  max: 128000
}

/**
 * How a model takes an effort setting: the top-level request field that
 * carries `effort` (Claude: `output_config`; GPT, Grok: `reasoning`) and the
 * levels its enum allows.
 */
export interface EffortCapability {
  field: string
  levels: Effort[]
}

/**
 * Read effort control from a model's `additionalModelRequestFieldsSchema`, as
 * ListAvailableModels advertises it per model. Kiro validates request bodies
 * against this schema (unknown fields and out-of-enum levels are 400s; models
 * without a schema reject the field outright), so it is the authority: new
 * models and families light up without a plugin edit. Null = no effort field.
 */
export function effortCapabilityFromSchema(schema: unknown): EffortCapability | null {
  const properties = (schema as { properties?: unknown } | null)?.properties
  if (!properties || typeof properties !== 'object') return null
  for (const [field, spec] of Object.entries(properties)) {
    const values = (spec as any)?.properties?.effort?.enum
    if (!Array.isArray(values)) continue
    const levels = EFFORT_LEVELS.filter((level) => values.includes(level))
    if (levels.length > 0) return { field, levels }
  }
  return null
}

const advertised = new Map<string, EffortCapability | null>()

/**
 * Record what the account's model list says about a model. `undefined` (a
 * model list cached before the plugin read the schema) leaves the version
 * rule below in charge.
 */
export function registerEffortCapability(kiroModel: string, capability: unknown): void {
  if (capability === undefined) return
  const c = capability as Partial<EffortCapability> | null
  const raw = c?.levels
  const levels = Array.isArray(raw) ? EFFORT_LEVELS.filter((level) => raw.includes(level)) : []
  advertised.set(
    kiroModel,
    typeof c?.field === 'string' && levels.length > 0 ? { field: c.field, levels } : null
  )
}

/**
 * Stop sending effort to a model after Kiro rejected the field anyway; the
 * next catalog build re-reads the advertised schema.
 */
export function disableEffort(kiroModel: string): void {
  advertised.set(kiroModel, null)
}

/**
 * Fallback for model lists cached before the plugin read the schema: the
 * Claude version rule the plugin used before (Opus and Sonnet from 4.5, Haiku
 * from 5; xhigh on Opus from 4.7 and on everything else from 5).
 */
function parseClaudeVersion(
  kiroModel: string
): { family: 'opus' | 'sonnet' | 'haiku'; major: number; minor: number } | undefined {
  const match = /^claude-(opus|sonnet|haiku)-(\d+)(?:\.(\d+))?/.exec(kiroModel)
  if (!match) return undefined
  return {
    family: match[1] as 'opus' | 'sonnet' | 'haiku',
    major: Number(match[2]),
    minor: match[3] ? Number(match[3]) : 0
  }
}

function versionRuleCapability(kiroModel: string): EffortCapability | null {
  const v = parseClaudeVersion(kiroModel)
  if (!v) return null
  const supported =
    v.family === 'haiku' ? v.major >= 5 : v.major > 4 || (v.major === 4 && v.minor >= 5)
  if (!supported) return null
  const xhigh = v.family === 'opus' ? v.major > 4 || (v.major === 4 && v.minor >= 7) : v.major >= 5
  return { field: 'output_config', levels: EFFORT_LEVELS.filter((l) => xhigh || l !== 'xhigh') }
}

/** Effort control for a model: the advertised schema, else the version rule. */
export function effortCapability(kiroModel: string): EffortCapability | null {
  return advertised.has(kiroModel)
    ? (advertised.get(kiroModel) ?? null)
    : versionRuleCapability(kiroModel)
}

/**
 * Check if a model supports the effort parameter.
 */
export function supportsEffort(kiroModel: string): boolean {
  return effortCapability(kiroModel) !== null
}

/**
 * Check if a model supports xhigh effort level.
 */
export function supportsXHighEffort(kiroModel: string): boolean {
  return effortCapability(kiroModel)?.levels.includes('xhigh') ?? false
}

/**
 * Resolve effort level for a given model.
 * - Returns undefined if model doesn't support effort
 * - Otherwise the nearest level the model accepts, preferring the next one up
 *   (xhigh -> max where xhigh is missing, max -> xhigh where max is missing)
 */
export function resolveEffort(kiroModel: string, requested: Effort): Effort | undefined {
  const levels = effortCapability(kiroModel)?.levels
  if (!levels) return undefined
  if (levels.includes(requested)) return requested
  const index = EFFORT_LEVELS.indexOf(requested)
  return (
    EFFORT_LEVELS.slice(index + 1).find((level) => levels.includes(level)) ??
    EFFORT_LEVELS.slice(0, index)
      .reverse()
      .find((level) => levels.includes(level))
  )
}

/**
 * Map OpenCode thinking budget to Kiro effort level.
 *
 * Budget bands are scaled to Kiro's real thinking ceiling (1024–128000 for
 * opus-4.8/opus-5), not OpenCode's conventional 32768 cap, so the full effort
 * enum is reachable. Reference budgets:
 * - low:    16384
 * - medium: 32768
 * - high:   65536
 * - xhigh:  98304
 * - max:    128000
 *
 * Each THINKING_BUDGETS value is the inclusive upper bound of its band, so a
 * variant configured with a reference budget maps back to the same level:
 * - ≤16384  → low
 * - ≤32768  → medium
 * - ≤65536  → high
 * - ≤98304  → xhigh (clamped to max on models without xhigh support)
 * - >98304  → max
 */
export function budgetToEffort(budget: number, kiroModel: string): Effort | undefined {
  if (!supportsEffort(kiroModel)) {
    return undefined
  }

  // EFFORT_LEVELS is ordered low→max, so the first band the budget fits wins.
  const effort =
    EFFORT_LEVELS.find((level) => budget <= THINKING_BUDGETS[level]) ??
    EFFORT_LEVELS[EFFORT_LEVELS.length - 1]!

  return resolveEffort(kiroModel, effort)
}

/**
 * Get the effective effort level based on config, budget, and model.
 *
 * Priority:
 * 1. Explicit effort config (if set) - always applied regardless of thinking state
 * 2. Budget-to-effort mapping (if auto_effort_mapping enabled and thinking)
 * 3. 'medium' default (if thinking enabled)
 * 4. undefined (if not thinking)
 */
export function getEffectiveEffort(
  kiroModel: string,
  thinking: boolean,
  budget: number,
  configEffort?: Effort,
  autoEffortMapping = true
): Effort | undefined {
  if (!supportsEffort(kiroModel)) {
    return undefined
  }

  // Explicit config takes precedence - always applied even without thinking
  if (configEffort) {
    return resolveEffort(kiroModel, configEffort)
  }

  // If not thinking, no effort needed
  if (!thinking) {
    return undefined
  }

  // Auto-map budget to effort
  if (autoEffortMapping) {
    return budgetToEffort(budget, kiroModel)
  }

  // Default to medium when thinking without auto-mapping
  return 'medium'
}
