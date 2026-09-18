// Registers the "kiro" integration + two OAuth auth methods on the V2 host
// (ctx.integration.transform). `opencode auth login` lists these methods,
// prompts the declared form fields, and passes the answer to authorize().

import { IdcAuthMethod } from '../core/auth/idc-auth-method.js'
import type { AccountRepository } from '../infrastructure/database/account-repository.js'
import { decodeRefreshToken } from '../kiro/auth.js'
import type { AccountManager } from '../plugin/accounts.js'
import type { KiroConfig } from '../plugin/config/schema.js'
import { refreshAccessToken } from '../plugin/token.js'
import type { KiroRegion } from '../plugin/types.js'
import type {
  CredentialOAuth,
  FormAnswer,
  FormField,
  IntegrationOAuthAuthorization,
  PluginContext,
  Registration
} from './host-types.js'

const KIRO_INTEGRATION_ID = 'kiro'
const DEFAULT_REGION = 'us-east-1'

/** Payload the host seam is expected to attach to the authorization callback result. */
export interface KiroCredentialPayload {
  refresh: string
  access: string
  expires: number
  metadata?: Record<string, unknown>
}

/** Structural view of IdcAuthMethod.authorize's result (the real type is the host's AuthOuathResult). */
export interface UpstreamAuthorizeResult {
  url: string
  instructions: string
  method: string
  callback: () => Promise<{ type: string; key: string; credential?: KiroCredentialPayload }>
}

export interface KiroAuthDeps {
  config: KiroConfig
  repository: AccountRepository
  accountManager: AccountManager
}

export const KIRO_AUTH_METHOD_IDS = {
  builderId: 'builder-id',
  idcProfileArn: 'idc-profile-arn'
} as const

function stringOf(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

function regionOf(credential: CredentialOAuth): string {
  return stringOf(credential.metadata?.region) ?? DEFAULT_REGION
}

export function buildStartUrlField(config: KiroConfig): FormField {
  return {
    key: 'start_url',
    title: 'IAM Identity Center Start URL',
    type: 'string',
    format: 'uri',
    required: false,
    placeholder: 'https://your-company.awsapps.com/start',
    description: config.idc_start_url
      ? 'Leave blank to keep the configured value.'
      : 'Leave blank for AWS Builder ID.'
  }
}

export function buildRegionField(config: KiroConfig): FormField {
  return {
    key: 'idc_region',
    title: 'IAM Identity Center region (sso_region)',
    type: 'string',
    required: false,
    placeholder: DEFAULT_REGION,
    pattern: '^(us|eu|ap|sa|ca|me|af|il)-[a-z]+-\\d+$',
    description:
      config.idc_region && config.idc_region !== DEFAULT_REGION
        ? 'Leave blank to keep the configured value.'
        : `Leave blank for ${DEFAULT_REGION}.`
  }
}

export function buildProfileArnField(config: KiroConfig): FormField {
  return {
    key: 'profile_arn',
    title: 'CodeWhisperer / Q Developer Profile ARN',
    type: 'string',
    required: !config.idc_profile_arn,
    placeholder: 'arn:aws:codewhisperer:us-east-1:123456789012:profile/XXXXXXXXXX',
    pattern: '^arn:aws:(codewhisperer|qdeveloper):.+profile/.+',
    description: config.idc_profile_arn
      ? 'Leave blank to keep the configured value.'
      : 'Required for this method.'
  }
}

export async function registerKiroAuth(
  ctx: PluginContext,
  deps: KiroAuthDeps
): Promise<Registration> {
  const config = deps.config
  const idcMethod = new IdcAuthMethod(config, deps.repository, deps.accountManager)

  return ctx.integration.transform((editor) => {
    editor.update(KIRO_INTEGRATION_ID, (integration) => {
      integration.name = 'Kiro'
    })

    editor.method.update({
      integrationID: KIRO_INTEGRATION_ID,
      method: {
        id: KIRO_AUTH_METHOD_IDS.builderId,
        type: 'oauth',
        label: 'AWS Builder ID / IAM Identity Center',
        form: [buildStartUrlField(config), buildRegionField(config)]
      },
      authorize: makeAuthorize(idcMethod, KIRO_AUTH_METHOD_IDS.builderId, config),
      refresh: makeRefresh(),
      label: credentialLabel
    })

    editor.method.update({
      integrationID: KIRO_INTEGRATION_ID,
      method: {
        id: KIRO_AUTH_METHOD_IDS.idcProfileArn,
        type: 'oauth',
        label: 'IAM Identity Center with Profile ARN',
        form: [buildStartUrlField(config), buildRegionField(config), buildProfileArnField(config)]
      },
      authorize: makeAuthorize(idcMethod, KIRO_AUTH_METHOD_IDS.idcProfileArn, config),
      refresh: makeRefresh(),
      label: credentialLabel
    })
  })
}

function makeAuthorize(
  idcMethod: IdcAuthMethod,
  methodID: string,
  _config: KiroConfig
): (answer: FormAnswer) => Promise<IntegrationOAuthAuthorization> {
  return async (answer) => {
    const inputs: Record<string, string> = {}
    for (const key of ['start_url', 'idc_region', 'profile_arn'] as const) {
      const value = answer[key]
      if (typeof value === 'string' && value.trim()) inputs[key] = value.trim()
    }

    // Upstream opens the browser and starts the device flow.
    const result = (await idcMethod.authorize(inputs)) as unknown as UpstreamAuthorizeResult

    return toHostAuthorization(result, methodID)
  }
}

/**
 * Maps the upstream device-flow result onto the host's promise-flavor OAuth authorization.
 *
 * `mode: "auto"` carries a Promise VALUE, not a function: see upstream
 * `packages/plugin/src/promise/integration.ts:46-48` and its adapter, which wraps the field as
 * `Effect.promise(() => authorization.callback)`. Handing it a function means the host calls
 * `.then` on that function and the whole login fails with `... then is not a function`.
 */
export function toHostAuthorization(
  result: UpstreamAuthorizeResult,
  methodID: string
): IntegrationOAuthAuthorization {
  const callback = (async (): Promise<CredentialOAuth> => {
    const out = await result.callback()
    if (out.type !== 'success') throw new Error('Kiro authorization failed')
    const payload = out.credential
    if (!payload) {
      throw new Error(
        'kiro-auth-v2: authorization callback returned no credential payload (host seam mismatch)'
      )
    }
    return {
      type: 'oauth' as const,
      methodID,
      refresh: payload.refresh,
      access: payload.access,
      expires: payload.expires,
      metadata: payload.metadata
    }
  })()

  // Observe the rejection now: the device flow can fail before the host attaches its handlers.
  callback.catch(() => {})

  return {
    url: result.url,
    instructions: result.instructions,
    mode: 'auto' as const,
    callback
  }
}

function makeRefresh(): (credential: CredentialOAuth) => Promise<CredentialOAuth> {
  return async (credential) => {
    try {
      const parts = decodeRefreshToken(credential.refresh)
      const result = await refreshAccessToken({
        refresh: credential.refresh,
        access: credential.access,
        expires: credential.expires,
        authMethod: parts.authMethod ?? 'desktop',
        region: regionOf(credential) as KiroRegion,
        oidcRegion: (stringOf(credential.metadata?.oidcRegion) ??
          regionOf(credential)) as KiroRegion,
        profileArn: stringOf(credential.metadata?.profileArn),
        clientId: parts.clientId,
        clientSecret: parts.clientSecret,
        email: stringOf(credential.metadata?.email)
      })

      return {
        type: 'oauth' as const,
        methodID: credential.methodID,
        refresh: result.refresh,
        access: result.access,
        expires: result.expires,
        metadata: credential.metadata
      }
    } catch (err) {
      throw new Error(
        `Kiro token refresh failed: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }
}

const credentialLabel = (credential: CredentialOAuth): string | undefined => {
  const email = credential.metadata?.email
  return typeof email === 'string' && email ? email : undefined
}
