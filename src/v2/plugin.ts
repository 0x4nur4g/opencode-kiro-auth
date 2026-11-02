// V2 entry composition: {id, setup} default-export shape for OpenCode 2.0.x.
// setup wires the loopback gateway, provider/model catalog, auth methods,
// and the web-search tool onto the host plugin context.

import { AuthHandler } from '../core/auth/auth-handler.js'
import { RequestHandler } from '../core/request/request-handler.js'
import { AccountCache } from '../infrastructure/database/account-cache.js'
import { AccountRepository } from '../infrastructure/database/account-repository.js'
import { AccountManager } from '../plugin/accounts.js'
import { loadConfig } from '../plugin/config/index.js'
import * as logger from '../plugin/logger.js'
import { loadCachedModels, saveCachedModels } from '../plugin/model-cache.js'
import { KIRO_AUTH_METHOD_IDS, registerKiroAuth } from './auth.js'
import { buildV2ModelRegistry, registerKiroCatalog } from './catalog.js'
import { validateHostSurfaces } from './context.js'
import { discoverAccountModels } from './discovery.js'
import { getSharedGateway, KiroGateway, setSharedGateway, type NotifyFn } from './gateway.js'
import type { PluginContext, PluginDefinition, Registration } from './host-types.js'
import { registerKiroTools } from './tools.js'

const KIRO_PROVIDER_ID = 'kiro'

/** Route host notifications into the upstream file logger. */
export function makeNotifier(): NotifyFn {
  return (message, variant) => {
    if (variant === 'error') {
      logger.error(message)
    } else if (variant === 'warn') {
      logger.warn(message)
    } else {
      logger.log(message)
    }
  }
}

/**
 * Adapt the upstream `ToastFunction` spelling (`'warning'`) onto this plugin's
 * `NotifyFn` union; unknown variants degrade to a plain log line.
 */
export function asToast(message: string, variant: string): void {
  if (variant === 'warning') {
    makeNotifier()(message, 'warn')
    return
  }
  if (variant === 'info' || variant === 'success' || variant === 'error' || variant === 'warn') {
    makeNotifier()(message, variant)
    return
  }
  logger.log(message)
}

export async function setup(ctx: PluginContext): Promise<() => Promise<void>> {
  validateHostSurfaces(ctx)

  const config = loadConfig(ctx.location.directory)
  const notify = makeNotifier()

  const cache = new AccountCache(60000)
  const repository = new AccountRepository(cache)
  const accountManager = await AccountManager.loadFromDisk(config.account_selection_strategy)

  const authHandler = new AuthHandler(config, repository)
  authHandler.setAccountManager(accountManager)

  // Headless reauth: kick off the browser device flow when the host exposes an
  // OAuth surface, then point the user at the manual path. Best-effort.
  const reauth = async (): Promise<boolean> => {
    const oauth = ctx.integration.oauth
    try {
      if (oauth) {
        void Promise.resolve(
          oauth.connect({
            integrationID: 'kiro',
            methodID: KIRO_AUTH_METHOD_IDS.builderId,
            answer: {}
          })
        ).catch(() => undefined)
      }
    } catch {
      /* headless reauth attempt is best-effort */
    }
    logger.warn(
      'Kiro accounts are unhealthy. Start a fresh login with `opencode auth login` (select Kiro).'
    )
    return false
  }

  const requestHandler = new RequestHandler(accountManager, config, repository, reauth)

  const existing = getSharedGateway()
  const region = config.default_region || 'us-east-1'
  const gateway = existing ?? new KiroGateway(requestHandler, notify, region)
  if (!existing) {
    await gateway.start()
    setSharedGateway(gateway)
    notify(`Kiro gateway created at ${gateway.url()}`, 'info')
  } else {
    notify(`Kiro gateway reused at ${gateway.url()}`, 'info')
  }
  const ownerToken = gateway.claim(requestHandler, notify, region)

  // The catalog is generated from the account, never maintained by hand:
  // start from the last-good cache, then background discovery (below) swaps in
  // the live ListAvailableModels result. The catalog transform reads through
  // getModels, so it picks the new list up on replay.
  const catalogModels = { current: buildV2ModelRegistry(KIRO_PROVIDER_ID, loadCachedModels()) }

  const regs: Registration[] = []
  regs.push(
    await registerKiroCatalog(ctx, {
      providerID: KIRO_PROVIDER_ID,
      gatewayUrl: () => gateway.url(),
      gatewayLive: () => gateway.isLive(),
      getModels: () => catalogModels.current
    })
  )
  regs.push(await registerKiroAuth(ctx, { config, repository, accountManager }))
  regs.push(await registerKiroTools(ctx, { config, accountManager }))
  await authHandler.initialize(asToast)

  // Background catalog refresh from the logged-in accounts. Never blocks
  // setup; on failure the cached list stays (a failed list call means
  // inference would fail too, so there is no static fallback list).
  void (async () => {
    try {
      const discovered = await discoverAccountModels({ config, accountManager, repository })
      if (!discovered || discovered.length === 0) return
      saveCachedModels(discovered)
      catalogModels.current = buildV2ModelRegistry(KIRO_PROVIDER_ID, discovered)
      try {
        await ctx.provider.reload?.()
      } catch {
        /* transform replay happens on catalog events anyway */
      }
      try {
        await ctx.model.reload?.()
      } catch {
        /* transform replay happens on catalog events anyway */
      }
    } catch (e) {
      logger.warn('Kiro model discovery failed; keeping cached catalog', {
        error: e instanceof Error ? e.message : String(e)
      })
    }
  })()

  return async () => {
    for (const r of regs) {
      try {
        await r.dispose()
      } catch {
        /* teardown best-effort */
      }
    }
    // `setup` can run more than once per process (hot reload / duplicate
    // registration). A later run claims the shared listener; only the run that
    // still owns it may stop it.
    if (gateway.release(ownerToken)) setSharedGateway(undefined)
  }
}

export const kiroV2Plugin: PluginDefinition = { id: 'kiro', setup }

export function createKiroV2Plugin(): PluginDefinition {
  return { id: 'kiro', setup }
}
