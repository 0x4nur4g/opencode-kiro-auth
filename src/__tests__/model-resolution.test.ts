import { describe, expect, test } from 'bun:test'
import { resolveKiroModel } from '../plugin/models.js'

describe('resolveKiroModel', () => {
  test('resolves newly advertised model slugs', () => {
    expect(resolveKiroModel('auto')).toBe('auto')
    expect(resolveKiroModel('deepseek-3.2')).toBe('deepseek-3.2')
    expect(resolveKiroModel('minimax-m2.5')).toBe('minimax-m2.5')
    expect(resolveKiroModel('minimax-m2.1')).toBe('minimax-m2.1')
    expect(resolveKiroModel('qwen3-coder-next')).toBe('qwen3-coder-next')
  })

  test('keeps existing supported Claude slugs intact', () => {
    expect(resolveKiroModel('claude-sonnet-4-5')).toBe('claude-sonnet-4.5')
    expect(resolveKiroModel('claude-sonnet-4')).toBe('claude-sonnet-4')
    expect(resolveKiroModel('claude-opus-4-8')).toBe('claude-opus-4.8')
    expect(resolveKiroModel('claude-opus-4-8-thinking')).toBe('claude-opus-4.8')
  })

  test('resolves claude-sonnet-5 slugs', () => {
    expect(resolveKiroModel('claude-sonnet-5')).toBe('claude-sonnet-5')
    expect(resolveKiroModel('claude-sonnet-5-thinking')).toBe('claude-sonnet-5')
    expect(resolveKiroModel('claude-sonnet-5-1m')).toBe('claude-sonnet-5-1m')
    expect(resolveKiroModel('claude-sonnet-5-1m-thinking')).toBe('claude-sonnet-5-1m')
  })

  // No local allowlist: unregistered slugs are normalized and passed through;
  // Kiro itself accepts or rejects them (its error surfaces to the user).
  test('passes unknown slugs through to Kiro', () => {
    expect(resolveKiroModel('qwen3-coder-480b')).toBe('qwen3-coder-480b')
    expect(resolveKiroModel('this-model-does-not-exist')).toBe('this-model-does-not-exist')
  })
})
