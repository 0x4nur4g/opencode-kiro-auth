import { describe, expect, test } from 'bun:test'
import { isLongContextModel, normalizeRegion } from '../constants.js'

describe('isLongContextModel', () => {
  test('returns true for -1m suffixed model variants', () => {
    expect(isLongContextModel('claude-sonnet-4-6-1m')).toBe(true)
    expect(isLongContextModel('claude-sonnet-5-1m-thinking')).toBe(true)
  })

  test('returns false for standard context models', () => {
    expect(isLongContextModel('claude-opus-4-8')).toBe(false)
    expect(isLongContextModel('deepseek-3.2')).toBe(false)
  })

  test('returns false for unknown model strings', () => {
    expect(isLongContextModel('unknown-model')).toBe(false)
    expect(isLongContextModel('')).toBe(false)
    expect(isLongContextModel('claude-sonnet-4-6')).toBe(false)
  })
})

describe('normalizeRegion', () => {
  test('accepts configured AWS regions with the installed Zod enum shape', () => {
    expect(normalizeRegion('us-west-2')).toBe('us-west-2')
  })
})
