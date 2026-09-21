import { describe, expect, test } from 'bun:test'
import { toHostAuthorization } from '../v2/auth.js'
import type { UpstreamAuthorizeResult } from '../v2/auth.js'
import type { IntegrationOAuthAuthorization } from '../v2/host-types.js'

function stubAuthorization(
  overrides: Partial<UpstreamAuthorizeResult> = {}
): UpstreamAuthorizeResult {
  return {
    url: 'https://device.example/verify',
    instructions: 'Open the URL and enter the verification code.',
    method: 'builder-id',
    callback: async () => ({
      type: 'success',
      key: 'stub-key',
      credential: {
        refresh: 'stub-refresh',
        access: 'stub-access',
        expires: 1234567890
      }
    }),
    ...overrides
  }
}

describe('oauth authorization callback shape', () => {
  // Regression guard for the promise-flavor oauth `mode: "auto"` contract: the host adapter
  // wraps this field as `Effect.promise(() => authorization.callback)`, so it must be a Promise
  // VALUE, not a function. A function-valued callback made the host call `.then` on the function
  // and killed login live on runtime 2.0.7 (2026-09-18) with
  // `E()=>e(r)).then is not a function`. This test pins the promise-VALUE shape.
  test('auto mode returns a thenable value, not a function', async () => {
    const authz = toHostAuthorization(stubAuthorization(), 'kiro/builder-id')

    expect(authz.mode).toBe('auto')
    // Narrow to the auto variant before touching the callback field.
    if (authz.mode !== 'auto') throw new Error('expected mode "auto"')

    // `typeof authz.callback !== 'function'` is the historic bug: a function value is never
    // invoked by the host adapter, which awaits `authorization.callback` directly.
    expect(typeof authz.callback).not.toBe('function')
    expect(typeof authz.callback.then).toBe('function')

    const credential = await authz.callback
    expect(credential.type).toBe('oauth')
    expect(credential.methodID).toBe('kiro/builder-id')
    expect(credential.refresh).toBe('stub-refresh')
    expect(credential.access).toBe('stub-access')
    expect(credential.expires).toBe(1234567890)
  })

  test('code mode carries a callable function (union contract)', async () => {
    const authz: IntegrationOAuthAuthorization = {
      url: 'https://device.example/verify',
      instructions: 'Open the URL and enter the verification code.',
      mode: 'code',
      callback: async (code: string) => ({
        type: 'oauth' as const,
        methodID: 'kiro/idc-profile-arn',
        refresh: `stub-refresh-${code}`,
        access: 'stub-access',
        expires: 1234567890
      })
    }

    if (authz.mode !== 'code') throw new Error('expected mode "code"')

    expect(typeof authz.callback).toBe('function')
    const credential = await authz.callback('stub-code')
    expect(credential.methodID).toBe('kiro/idc-profile-arn')
    expect(credential.refresh).toBe('stub-refresh-stub-code')
  })
})