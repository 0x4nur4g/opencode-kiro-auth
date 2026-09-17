import type { PluginContext } from './host-types.js'

const ERROR_PREFIX = 'kiro-auth-v2:'

/**
 * Validate the host surfaces this plugin requires before any registration runs.
 *
 * Throws with a clear `kiro-auth-v2:` prefixed message when a required surface is
 * missing, so a contract drift fails loudly at setup instead of silently later.
 * Optional surfaces (`integration.connection`, `integration.oauth`, `session`)
 * are never rejected here — callers degrade when they are absent.
 */
export function validateHostSurfaces(ctx: PluginContext): void {
  const provider = (ctx as { provider?: { transform?: unknown } } | undefined)?.provider
  if (typeof provider?.transform !== 'function') {
    throw new Error(
      `${ERROR_PREFIX} provider.transform is missing; the V2 host contract has changed`
    )
  }

  const model = (ctx as { model?: { transform?: unknown } } | undefined)?.model
  if (typeof model?.transform !== 'function') {
    throw new Error(`${ERROR_PREFIX} model.transform is missing; the V2 host contract has changed`)
  }

  const tool = (ctx as { tool?: { transform?: unknown } } | undefined)?.tool
  if (typeof tool?.transform !== 'function') {
    throw new Error(`${ERROR_PREFIX} tool.transform is missing; the V2 host contract has changed`)
  }

  const integration = (ctx as { integration?: { transform?: unknown } } | undefined)?.integration
  if (typeof integration?.transform !== 'function') {
    throw new Error(
      `${ERROR_PREFIX} integration.transform is missing; the V2 host contract has changed`
    )
  }
}
