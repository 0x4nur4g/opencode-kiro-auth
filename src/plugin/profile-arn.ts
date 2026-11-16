import { extractRegionFromArn } from '../constants'
import { managementCall } from './available-models'
import * as logger from './logger'
import type { KiroAuthDetails } from './types'

/**
 * Current Kiro inference calls require a profileArn for account types that
 * used to be served without one; the stored account rows are not guaranteed to
 * carry it (accounts imported from kiro-cli often arrive without it). Resolve
 * it from ListAvailableProfiles on the same management surface model discovery
 * already uses, and let the caller persist the result.
 */
export async function resolveProfileArn(auth: KiroAuthDetails): Promise<string | undefined> {
  const candidates = [
    ...new Set(
      [extractRegionFromArn(auth.profileArn), auth.region, 'us-east-1', 'eu-central-1'].filter(
        (r): r is string => typeof r === 'string' && r.length > 0
      )
    )
  ]
  for (const region of candidates) {
    try {
      const data: any = await managementCall(
        auth,
        region,
        'AmazonCodeWhispererService.ListAvailableProfiles',
        { maxResults: 10 }
      )
      const arn = (Array.isArray(data?.profiles) ? data.profiles : [])
        .map((p: any) => p?.arn)
        .find((a: unknown): a is string => typeof a === 'string' && a.length > 0)
      if (arn) return arn
    } catch (e) {
      logger.debug(`Kiro profile discovery failed in ${region}`, {
        error: e instanceof Error ? e.message : String(e)
      })
    }
  }
  return undefined
}
