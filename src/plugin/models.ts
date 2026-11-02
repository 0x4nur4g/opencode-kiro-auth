import { isLongContextModel } from '../constants'

/**
 * Runtime model resolution. There is no maintained model list: the catalog is
 * generated from the account's ListAvailableModels response (and its on-disk
 * cache), and every advertised model registers its OpenCode ID -> Kiro wire ID
 * pair here. Module scope is fine — the host re-evaluates this module on
 * reload, and catalog construction re-registers every pair before any request
 * can arrive.
 */
const wireIdByOpenCodeId = new Map<string, string>()
const contextByOpenCodeId = new Map<string, number>()

export function registerModelPair(openCodeId: string, wireId: string, contextTokens?: number): void {
  wireIdByOpenCodeId.set(openCodeId, wireId)
  if (contextTokens && contextTokens > 0) contextByOpenCodeId.set(openCodeId, contextTokens)
}

export function knownModelIds(): string[] {
  return [...wireIdByOpenCodeId.keys()]
}

/**
 * Resolve an OpenCode-facing model ID to the Kiro wire ID.
 *
 * Registered pairs win. Anything else is normalized (Claude dash-form version
 * `claude-opus-4-5` -> `claude-opus-4.5`) and passed through: Kiro is the
 * arbiter of what it accepts, and an unknown ID gets Kiro's own error rather
 * than a stale local allowlist rejection.
 */
export function resolveKiroModel(model: string): string {
  const registered = wireIdByOpenCodeId.get(model)
  if (registered) return registered
  const withoutThinking = model.endsWith('-thinking') ? model.slice(0, -'-thinking'.length) : model
  const registeredBase = wireIdByOpenCodeId.get(withoutThinking)
  if (registeredBase) return registeredBase
  // `(?=-|$)` keeps the `-1m` long-context suffix intact (`-5-1m` is not `-5.1`).
  return withoutThinking.replace(/-(\d+)-(\d+)(?=-|$)/g, '-$1.$2')
}

export function getContextWindowSize(model: string): number {
  const known = contextByOpenCodeId.get(model)
  if (known) return known
  return isLongContextModel(model) ? 1000000 : 200000
}
