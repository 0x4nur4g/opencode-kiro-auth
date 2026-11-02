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
 * Effort capability by Claude version rule, not a maintained model list
 * (the catalog itself is generated per account; new releases must not need a
 * plugin edit to light up):
 *
 * - 4-value effort enum (low/medium/high/max): Opus and Sonnet from 4.5 on.
 * - 5-value enum (adds xhigh): Opus from 4.7 on, Sonnet from 5 on.
 *   xhigh requests elsewhere are clamped to max.
 *
 * Haiku and non-Claude models take no effort parameter.
 */
function parseClaudeVersion(
  kiroModel: string
): { family: 'opus' | 'sonnet'; major: number; minor: number } | undefined {
  const match = /^claude-(opus|sonnet)-(\d+)(?:\.(\d+))?/.exec(kiroModel)
  if (!match) return undefined
  return {
    family: match[1] as 'opus' | 'sonnet',
    major: Number(match[2]),
    minor: match[3] ? Number(match[3]) : 0
  }
}

/**
 * Check if a model supports the effort parameter.
 */
export function supportsEffort(kiroModel: string): boolean {
  const v = parseClaudeVersion(kiroModel)
  if (!v) return false
  return v.major > 4 || (v.major === 4 && v.minor >= 5)
}

/**
 * Check if a model supports xhigh effort level.
 */
export function supportsXHighEffort(kiroModel: string): boolean {
  const v = parseClaudeVersion(kiroModel)
  if (!v) return false
  if (v.family === 'opus') return v.major > 4 || (v.major === 4 && v.minor >= 7)
  return v.major >= 5
}

/**
 * Resolve effort level for a given model.
 * - Returns undefined if model doesn't support effort
 * - Clamps xhigh to max for models that don't support it
 */
export function resolveEffort(kiroModel: string, requested: Effort): Effort | undefined {
  if (!supportsEffort(kiroModel)) {
    return undefined
  }

  // xhigh is only supported on the models in XHIGH_CAPABLE_MODELS
  if (requested === 'xhigh' && !supportsXHighEffort(kiroModel)) {
    return 'max'
  }

  return requested
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
