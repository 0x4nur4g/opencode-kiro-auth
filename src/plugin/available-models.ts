import { extractRegionFromArn } from '../constants'
import type { KiroAuthDetails } from './types'

/**
 * One model as Kiro's ListAvailableModels advertises it for an account.
 * Only the fields this plugin consumes are kept; the endpoint sends more
 * (prompt-caching hints, lifecycle status) that the catalog does not need.
 */
export interface WireModel {
  modelId: string
  modelName?: string
  maxInputTokens?: number
  maxOutputTokens?: number
  rateMultiplier?: number
}

/**
 * Fetch the models the logged-in account may actually use.
 *
 * Same host and auth shape as getUsageLimits (see usage.ts): a REST GET on
 * q.<region>.amazonaws.com with the account bearer. Entitlement is enforced
 * by Kiro at request time too, but this list is what the model picker should
 * show — it is per-account, so a static list can only ever be wrong.
 */
export async function fetchAvailableModels(auth: KiroAuthDetails): Promise<WireModel[]> {
  // Account shapes differ (Builder ID vs IAM Identity Center, with/without a
  // profile): the endpoint rejects some origin/profile combinations with 403
  // while accepting others for the same token, so walk the combinations like
  // fetchUsageLimits does. Only 403 advances to the next combination.
  const attempts: Array<{ origin?: string; withProfile: boolean }> = [
    { origin: 'AI_EDITOR', withProfile: true },
    { origin: 'AI_EDITOR', withProfile: false },
    { origin: 'KIRO_CLI', withProfile: true },
    { withProfile: true }
  ]

  let lastError: Error | undefined
  for (const attempt of attempts) {
    const url = new URL(`https://q.${auth.region}.amazonaws.com/ListAvailableModels`)
    if (attempt.origin) url.searchParams.set('origin', attempt.origin)
    if (attempt.withProfile && auth.profileArn) url.searchParams.set('profileArn', auth.profileArn)

    const res = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${auth.access}`,
        'Content-Type': 'application/json',
        'x-amzn-kiro-agent-mode': 'vibe',
        'amz-sdk-request': 'attempt=1; max=1'
      },
      signal: AbortSignal.timeout(15000)
    })

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      lastError = new Error(
        `ListAvailableModels failed: HTTP ${res.status} ${body.slice(0, 500)}`
      )
      if (res.status === 403) continue
      throw lastError
    }

    return parseModels(await res.json())
  }

  // The q-host REST surface rejects some account types outright ("Your
  // subscription does not support this application" for IdC accounts whose
  // tokens the inference path accepts fine). Current Kiro clients list models
  // on the management surface instead: AWS JSON 1.0 POST with an X-Amz-Target
  // header. Same response shape.
  try {
    return await fetchViaManagement(auth)
  } catch (e) {
    const mgmt = e instanceof Error ? e.message : String(e)
    throw lastError
      ? new Error(`${lastError.message} | management: ${mgmt}`)
      : new Error(mgmt)
  }
}

function managementHeaders(auth: KiroAuthDetails, target: string): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${auth.access}`,
    'Content-Type': 'application/x-amz-json-1.0',
    'X-Amz-Target': target
  }
  // Desktop (social) tokens need the token-type marker on this surface;
  // IdC tokens must not send it.
  if (auth.authMethod === 'desktop') headers.tokentype = 'EXTERNAL_IDP'
  return headers
}

async function managementCall(
  auth: KiroAuthDetails,
  region: string,
  target: string,
  body: Record<string, unknown>
): Promise<any> {
  const res = await fetch(`https://management.${region}.kiro.dev/`, {
    method: 'POST',
    headers: managementHeaders(auth, target),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000)
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`${target} (management ${region}) failed: HTTP ${res.status} ${text.slice(0, 500)}`)
  }
  return res.json()
}

async function fetchViaManagement(auth: KiroAuthDetails): Promise<WireModel[]> {
  // The stored profileArn is not always valid on this surface, and profiles
  // live in a specific region: discover profiles per candidate region (the
  // same probe current Kiro clients do), then list models against each
  // discovered profile.
  const candidates = [
    ...new Set(
      [extractRegionFromArn(auth.profileArn), auth.region, 'us-east-1', 'eu-central-1'].filter(
        (r): r is string => typeof r === 'string' && r.length > 0
      )
    )
  ]

  let lastError: Error | undefined
  for (const region of candidates) {
    let profileArns: string[] = []
    try {
      const data: any = await managementCall(
        auth,
        region,
        'AmazonCodeWhispererService.ListAvailableProfiles',
        { maxResults: 10 }
      )
      profileArns = (Array.isArray(data?.profiles) ? data.profiles : [])
        .map((p: any) => p?.arn)
        .filter((a: unknown): a is string => typeof a === 'string' && a.length > 0)
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e))
    }
    if (profileArns.length === 0 && auth.profileArn) profileArns = [auth.profileArn]
    profileArns.push('')

    for (const arn of profileArns) {
      try {
        const body: Record<string, unknown> = { origin: 'KIRO_CLI' }
        if (arn) body.profileArn = arn
        const data: any = await managementCall(
          auth,
          region,
          'AmazonCodeWhispererService.ListAvailableModels',
          body
        )
        return parseModels(data)
      } catch (e) {
        lastError = e instanceof Error ? e : new Error(String(e))
      }
    }
  }

  throw lastError ?? new Error('ListAvailableModels (management) failed')
}

function parseModels(data: any): WireModel[] {

  const raw: unknown[] = Array.isArray(data?.models) ? data.models : []
  const models: WireModel[] = []
  for (const entry of raw) {
    const e = entry as Record<string, unknown>
    if (typeof e?.modelId !== 'string' || !e.modelId) continue
    const limits = (e.tokenLimits ?? {}) as Record<string, unknown>
    models.push({
      modelId: e.modelId,
      modelName: typeof e.modelName === 'string' ? e.modelName : undefined,
      maxInputTokens: numberOf(limits.maxInputTokens),
      maxOutputTokens: numberOf(limits.maxOutputTokens),
      rateMultiplier: numberOf(e.rateMultiplier)
    })
  }
  return models
}

function numberOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}
