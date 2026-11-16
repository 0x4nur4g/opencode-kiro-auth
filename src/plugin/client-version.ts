import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { KIRO_IDE_VERSION } from '../constants'
import * as logger from './logger'
import { DB_PATH } from './storage/sqlite'

/**
 * Kiro's client-version gate (live since 2026-11-09) rejects client identities
 * whose User-Agent product token has no supported version, with HTTP 400
 * "This version of Kiro is no longer supported". The accepted identity is the
 * IDE fingerprint `KiroIDE-<current stable release>`.
 *
 * The accepted release moves, so the version is read from the same update
 * metadata the IDE itself uses, cached beside kiro.db, and refreshed daily.
 * `KIRO_IDE_VERSION` is only the seed / offline fallback.
 */
const METADATA_URL = 'https://prod.download.desktop.kiro.dev/stable/metadata-linux-x64-stable.json'
const CACHE_PATH = join(DB_PATH, '..', 'kiro-client-version.json')
const REFRESH_TTL_MS = 24 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 5000
const VERSION_RE = /^\d+\.\d+\.\d+$/

interface CacheFile {
  fetchedAt: number
  version: string
}

function readCache(): CacheFile | undefined {
  try {
    if (!existsSync(CACHE_PATH)) return undefined
    const parsed = JSON.parse(readFileSync(CACHE_PATH, 'utf8')) as Partial<CacheFile>
    if (typeof parsed.version !== 'string' || !VERSION_RE.test(parsed.version)) return undefined
    return {
      version: parsed.version,
      fetchedAt: typeof parsed.fetchedAt === 'number' ? parsed.fetchedAt : 0
    }
  } catch {
    return undefined
  }
}

function saveCache(entry: CacheFile): void {
  try {
    mkdirSync(join(CACHE_PATH, '..'), { recursive: true })
    writeFileSync(CACHE_PATH, JSON.stringify(entry, null, 2))
  } catch (e) {
    logger.warn('Kiro client version cache write failed', {
      error: e instanceof Error ? e.message : String(e)
    })
  }
}

const cached = readCache()
let version = cached?.version ?? KIRO_IDE_VERSION
let fetchedAt = cached?.fetchedAt ?? 0
let inflight: Promise<string> | undefined

/** Current client identity version (discovered or fallback). */
export function kiroIdeVersion(): string {
  return version
}

/** IDE-shaped product token the gate accepts, e.g. `KiroIDE-1.4.178`. */
export function kiroUserAgent(): string {
  return `KiroIDE-${version}`
}

/** True when the cached release is older than the refresh window. */
export function kiroVersionNeedsRefresh(): boolean {
  return Date.now() - fetchedAt > REFRESH_TTL_MS
}

/**
 * Fetch the current stable IDE release and adopt it. Best-effort: any failure
 * keeps the last-good version, so the plugin never degrades below its seed.
 */
export function refreshKiroIdeVersion(): Promise<string> {
  if (inflight) return inflight
  inflight = (async () => {
    try {
      const res = await fetch(METADATA_URL, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data: any = await res.json()
      const release = typeof data?.currentRelease === 'string' ? data.currentRelease : ''
      if (!VERSION_RE.test(release)) throw new Error(`unexpected currentRelease: ${release}`)
      if (release !== version) {
        logger.log(`Kiro client identity ${version} -> ${release}`)
        version = release
      }
      fetchedAt = Date.now()
      saveCache({ version, fetchedAt })
      return version
    } catch (e) {
      logger.warn('Kiro client version refresh failed; keeping last-good', {
        error: e instanceof Error ? e.message : String(e)
      })
      return version
    } finally {
      inflight = undefined
    }
  })()
  return inflight
}
