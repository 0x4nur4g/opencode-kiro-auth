import { describe, expect, test } from 'bun:test'
import type { RequestHandler } from '../core/request/request-handler.js'
import { KiroGateway, setSharedGateway } from '../v2/gateway.js'

const stubHandler = undefined as unknown as RequestHandler

const recordingNotify = () => {
  const lines: Array<{ message: string; variant: string }> = []
  const notify = (message: string, variant: 'info' | 'success' | 'warn' | 'error') => {
    lines.push({ message, variant })
  }
  return { lines, notify }
}

describe('gateway shared state across module re-evaluation', () => {
  // Regression guard (2026-09-21): the host re-evaluates the plugin module on reload, so
  // module-scope state resets on every re-evaluation. A module-scope `let sharedGateway`
  // made each reload bind a NEW loopback server (live log: 19 `Kiro gateway created at`
  // lines, 0 `reused`, two servers co-listening 2h21m). The shared gateway must be anchored
  // on the process global so a fresh module instance still finds the live listener.
  test('a fresh module instance sees the gateway stored by another instance', async () => {
    const gateway = new KiroGateway(stubHandler, recordingNotify().notify, 'us-east-1')
    try {
      setSharedGateway(gateway)
      // Distinct specifier (query string) -> distinct ESM instance of the module in Bun.
      // Typed as plain string so tsc does not try to resolve the queried specifier.
      const spec: string = '../v2/gateway.js?instance=2'
      const fresh = (await import(spec)) as typeof import('../v2/gateway.js')
      expect(fresh.getSharedGateway()).toBe(gateway)
    } finally {
      setSharedGateway(undefined)
    }
  })
})

describe('gateway stop visibility', () => {
  test('stop() emits a sanitized stop line through notify', async () => {
    const recorder = recordingNotify()
    const gateway = new KiroGateway(stubHandler, recorder.notify, 'us-east-1')
    await gateway.start()
    try {
      expect(gateway.url()).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)

      gateway.stop()

      const stopLine = recorder.lines.find((line) =>
        line.message.startsWith('Kiro gateway stopped at')
      )
      expect(stopLine).toBeDefined()
      expect(stopLine?.variant).toBe('info')
      // Sanitized lifecycle line: host/port only, never credentials.
      expect(stopLine?.message).toMatch(/^Kiro gateway stopped at http:\/\/127\.0\.0\.1:\d+$/)
      // Idempotent stop: the finally-block re-stop must stay silent (one line total).
      expect(
        recorder.lines.filter((line) => line.message.startsWith('Kiro gateway stopped at')).length
      ).toBe(1)
    } finally {
      // Idempotent; guarantees no listener leaks if an assertion above fails.
      gateway.stop()
    }
  })
})