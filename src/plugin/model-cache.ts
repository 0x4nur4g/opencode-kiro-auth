import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { WireModel } from './available-models'
import * as logger from './logger'
import { DB_PATH } from './storage/sqlite'

/**
 * Last-good ListAvailableModels result, persisted beside kiro.db.
 *
 * The catalog is generated from the account, never maintained by hand. The
 * cache exists so a restart shows the previous list immediately while the
 * background refresh runs — and shows nothing stale-but-plausible when the
 * account was never reachable: if listing models fails, inference would fail
 * too (same host, same token), so there is no static fallback list.
 */
const CACHE_PATH = join(DB_PATH, '..', 'kiro-models.json')

interface CacheFile {
  fetchedAt: number
  models: WireModel[]
}

export function loadCachedModels(): WireModel[] {
  try {
    if (!existsSync(CACHE_PATH)) return []
    const parsed = JSON.parse(readFileSync(CACHE_PATH, 'utf8')) as Partial<CacheFile>
    if (!Array.isArray(parsed.models)) return []
    return parsed.models.filter(
      (m): m is WireModel => !!m && typeof m.modelId === 'string' && m.modelId.length > 0
    )
  } catch (e) {
    logger.warn('Kiro model cache unreadable; starting with an empty catalog', {
      error: e instanceof Error ? e.message : String(e)
    })
    return []
  }
}

export function saveCachedModels(models: WireModel[]): void {
  try {
    mkdirSync(join(CACHE_PATH, '..'), { recursive: true })
    const payload: CacheFile = { fetchedAt: Date.now(), models }
    writeFileSync(CACHE_PATH, JSON.stringify(payload, null, 2))
  } catch (e) {
    logger.warn('Kiro model cache write failed', {
      error: e instanceof Error ? e.message : String(e)
    })
  }
}
