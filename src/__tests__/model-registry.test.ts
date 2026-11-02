import { describe, expect, test } from 'bun:test'
import type { WireModel } from '../plugin/available-models.js'
import type { Effort } from '../plugin/config/schema.js'
import { budgetToEffort, THINKING_BUDGETS } from '../plugin/effort.js'
import { buildModelRegistry } from '../plugin/model-registry.js'
import { knownModelIds, resolveKiroModel } from '../plugin/models.js'

// Fixture shaped like a ListAvailableModels response; the registry is
// generated from this data, never from a maintained in-repo list.
const FIXTURE: WireModel[] = [
  { modelId: 'auto', modelName: 'Auto', maxInputTokens: 200000 },
  { modelId: 'claude-sonnet-4.5', modelName: 'Claude Sonnet 4.5', maxInputTokens: 200000 },
  { modelId: 'claude-sonnet-4.6', modelName: 'Claude Sonnet 4.6', maxInputTokens: 1000000 },
  { modelId: 'claude-sonnet-5', modelName: 'Claude Sonnet 5', maxInputTokens: 1000000 },
  { modelId: 'claude-haiku-4.5', modelName: 'Claude Haiku 4.5', maxInputTokens: 200000 },
  { modelId: 'claude-opus-4.5', modelName: 'Claude Opus 4.5', maxInputTokens: 200000 },
  { modelId: 'claude-opus-4.6', modelName: 'Claude Opus 4.6', maxInputTokens: 1000000 },
  { modelId: 'claude-opus-4.7', modelName: 'Claude Opus 4.7', maxInputTokens: 1000000 },
  { modelId: 'claude-opus-4.8', modelName: 'Claude Opus 4.8', maxInputTokens: 1000000 },
  { modelId: 'claude-opus-5', modelName: 'Claude Opus 5', maxInputTokens: 1000000 },
  { modelId: 'deepseek-3.2', modelName: 'DeepSeek 3.2', maxInputTokens: 128000 },
  { modelId: 'gpt-5.6-sol', modelName: 'GPT-5.6 Sol', maxInputTokens: 1000000 }
]

const registry = buildModelRegistry(FIXTURE) as Record<string, any>

const thinkingIDs = Object.keys(registry).filter((id) => id.endsWith('-thinking'))
const XHIGH_MODELS = [
  'claude-opus-4-7-thinking',
  'claude-opus-4-8-thinking',
  'claude-opus-5-thinking',
  'claude-sonnet-5-thinking'
]

describe('model registry', () => {
  test('every advertised model is resolvable to a Kiro model ID', () => {
    for (const modelID of Object.keys(registry)) {
      expect(knownModelIds()).toContain(modelID)
      expect(resolveKiroModel(modelID)).toBeTruthy()
    }
  })

  test('advertises a thinking companion for each effort-capable Claude model', () => {
    expect(thinkingIDs.sort()).toEqual(
      [
        'claude-opus-4-5-thinking',
        'claude-opus-4-6-thinking',
        'claude-opus-4-7-thinking',
        'claude-opus-4-8-thinking',
        'claude-opus-5-thinking',
        'claude-sonnet-4-5-thinking',
        'claude-sonnet-4-6-thinking',
        'claude-sonnet-5-thinking'
      ].sort()
    )
  })

  test('advertises non-Claude models under their wire ID without thinking twins', () => {
    expect(registry['gpt-5.6-sol']).toBeDefined()
    expect(registry['gpt-5.6-sol-thinking']).toBeUndefined()
    expect(registry['deepseek-3.2']).toBeDefined()
  })

  describe('reasoning capability flags', () => {
    // Both are required: `reasoning` declares the capability, `interleaved.field`
    // tells OpenCode reasoning arrives as `reasoning_content` deltas. Missing
    // either one means reasoning chunks are silently dropped.
    test('every thinking model declares reasoning and the reasoning_content field', () => {
      for (const id of thinkingIDs) {
        expect(registry[id].reasoning).toBe(true)
        expect(registry[id].interleaved).toEqual({ field: 'reasoning_content' })
      }
    })

    test('non-thinking models declare neither', () => {
      for (const [id, model] of Object.entries(registry)) {
        if (id.endsWith('-thinking')) continue
        expect(model.reasoning).toBeUndefined()
        expect(model.interleaved).toBeUndefined()
      }
    })
  })

  describe('thinking variants', () => {
    test('offers xhigh only on models Kiro documents as xhigh-capable', () => {
      for (const id of thinkingIDs) {
        const hasXHigh = Object.keys(registry[id].variants).includes('xhigh')
        expect(hasXHigh).toBe(XHIGH_MODELS.includes(id))
      }
    })

    test('variant budgets map back to the effort level they are named for', () => {
      for (const id of thinkingIDs) {
        const kiroModel = resolveKiroModel(id)
        for (const [name, variant] of Object.entries<any>(registry[id].variants)) {
          const level = name as Effort
          const budget = variant.thinkingConfig.thinkingBudget
          expect(budget).toBe(THINKING_BUDGETS[level])
          expect(budgetToEffort(budget, kiroModel)).toBe(level)
        }
      }
    })

    test('variants are ordered low to max', () => {
      for (const id of thinkingIDs) {
        const budgets = Object.values<any>(registry[id].variants).map(
          (v) => v.thinkingConfig.thinkingBudget
        )
        expect(budgets).toEqual([...budgets].sort((a, b) => a - b))
      }
    })
  })

  test('carries limit and modalities through to both entries', () => {
    expect(registry['claude-opus-5'].limit).toEqual({ context: 1000000, output: 64000 })
    expect(registry['claude-opus-5-thinking'].limit).toEqual(registry['claude-opus-5'].limit)
    expect(registry['claude-opus-5-thinking'].modalities).toEqual(
      registry['claude-opus-5'].modalities
    )
  })
})
