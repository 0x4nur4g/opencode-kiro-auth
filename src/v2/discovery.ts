import { TokenRefresher } from '../core/auth/token-refresher.js'
import type { AccountRepository } from '../infrastructure/database/account-repository.js'
import type { AccountManager } from '../plugin/accounts.js'
import { fetchAvailableModels, type WireModel } from '../plugin/available-models.js'
import type { KiroConfig } from '../plugin/config/index.js'
import * as logger from '../plugin/logger.js'
import { syncFromKiroCli } from '../plugin/sync/kiro-cli.js'

/**
 * Refresh the model catalog from the logged-in accounts.
 *
 * Each healthy account is asked for its ListAvailableModels; the union is
 * returned (accounts on different tiers see different models, and the picker
 * serves all of them). Returns undefined when no account answered, so the
 * caller keeps the cached list — a failed list call means inference would
 * fail too, so there is deliberately no static fallback.
 */
export async function discoverAccountModels(deps: {
  config: KiroConfig
  accountManager: AccountManager
  repository: AccountRepository
}): Promise<WireModel[] | undefined> {
  const { config, accountManager, repository } = deps
  const refresher = new TokenRefresher(config, accountManager, syncFromKiroCli, repository)
  const byId = new Map<string, WireModel>()
  let answered = 0

  for (const acc of accountManager.getAccounts()) {
    if (!acc.isHealthy) continue
    try {
      const { account: usable } = await refresher.refreshIfNeeded(
        acc,
        accountManager.toAuthDetails(acc),
        () => {}
      )
      if (!usable.isHealthy) continue
      const models = await fetchAvailableModels(accountManager.toAuthDetails(usable))
      answered++
      for (const m of models) {
        if (!byId.has(m.modelId)) byId.set(m.modelId, m)
      }
    } catch (e) {
      logger.warn('Kiro model discovery failed for one account; trying the next', {
        email: acc.email,
        error: e instanceof Error ? e.message : String(e)
      })
    }
  }

  if (answered === 0) return undefined
  const models = [...byId.values()]
  logger.log(`Kiro model discovery: ${models.length} model(s) across ${answered} account(s)`)
  return models
}
