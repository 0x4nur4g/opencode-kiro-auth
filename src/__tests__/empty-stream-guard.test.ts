import { describe, expect, test } from 'bun:test'
import { EMPTY_STREAM_ERROR_MESSAGE } from '../plugin/streaming/openai-converter.js'
import { transformKiroStream } from '../plugin/streaming/stream-transformer.js'
import { transformSdkStream } from '../plugin/streaming/sdk-stream-transformer.js'

const MODEL = 'claude-sonnet-4-5'

function sdkStream(events: any[]) {
  return {
    generateAssistantResponseResponse: (async function* () {
      for (const event of events) yield event
    })()
  }
}

async function collectSdk(events: any[]): Promise<any[]> {
  const chunks: any[] = []
  for await (const chunk of transformSdkStream(sdkStream(events), MODEL, 'conversation-1')) {
    chunks.push(chunk)
  }
  return chunks
}

async function collectSse(raw: string): Promise<any[]> {
  const chunks: any[] = []
  for await (const chunk of transformKiroStream(new Response(raw), MODEL, 'conversation-1')) {
    chunks.push(chunk)
  }
  return chunks
}

function terminalChunk(chunks: any[]): any {
  return chunks.find(
    (chunk) =>
      chunk.choices?.[0]?.finish_reason !== null && chunk.choices?.[0]?.finish_reason !== undefined
  )
}

function errorChunk(chunks: any[]): any {
  return chunks.find((chunk) => chunk.error !== undefined)
}

function textOf(chunks: any[]): string {
  return chunks
    .map((chunk) => chunk.choices?.[0]?.delta?.content)
    .filter((text): text is string => typeof text === 'string')
    .join('')
}

function reasoningOf(chunks: any[]): string {
  return chunks
    .map((chunk) => chunk.choices?.[0]?.delta?.reasoning_content)
    .filter((text): text is string => typeof text === 'string')
    .join('')
}

describe('empty-stream guard (sdk path)', () => {
  test('signals a retryable error when the upstream stream ends with zero deltas', async () => {
    const chunks = await collectSdk([
      { meteringEvent: {} },
      { contextUsageEvent: { contextUsagePercentage: 12 } }
    ])

    expect(chunks).toHaveLength(1)
    expect(chunks[0].error).toEqual({ message: EMPTY_STREAM_ERROR_MESSAGE })
    expect(terminalChunk(chunks)).toBeUndefined()
  })

  test('keeps a normal content stream ending with finish_reason stop and usage', async () => {
    const chunks = await collectSdk([{ assistantResponseEvent: { content: 'Answer.' } }])

    expect(textOf(chunks)).toBe('Answer.')
    expect(errorChunk(chunks)).toBeUndefined()
    const terminal = terminalChunk(chunks)
    expect(terminal.choices[0].finish_reason).toBe('stop')
    expect(terminal.usage).toBeDefined()
    expect(typeof terminal.usage.total_tokens).toBe('number')
    expect(terminal.usage.total_tokens).toBeGreaterThanOrEqual(0)
  })

  test('keeps a tool-call-only stream ending with finish_reason tool_calls', async () => {
    const chunks = await collectSdk([
      {
        toolUseEvent: {
          name: 'get_weather',
          toolUseId: 'tool-use-1',
          input: 'query',
          stop: true
        }
      }
    ])

    expect(errorChunk(chunks)).toBeUndefined()
    const terminal = terminalChunk(chunks)
    expect(terminal.choices[0].finish_reason).toBe('tool_calls')
    expect(chunks.filter((chunk) => chunk.choices?.[0]?.delta?.tool_calls).length).toBeGreaterThan(0)
  })

  test('does not treat a native reasoning-only stream as empty', async () => {
    const chunks = await collectSdk([{ reasoningContentEvent: { text: 'weighing options' } }])

    expect(reasoningOf(chunks)).toBe('weighing options')
    expect(errorChunk(chunks)).toBeUndefined()
    const terminal = terminalChunk(chunks)
    expect(terminal.choices[0].finish_reason).toBe('stop')
  })
})

describe('empty-stream guard (sse path)', () => {
  test('signals a retryable error when the upstream stream ends with zero deltas', async () => {
    const chunks = await collectSse('{"contextUsagePercentage":12}')

    expect(chunks).toHaveLength(1)
    expect(chunks[0].error).toEqual({ message: EMPTY_STREAM_ERROR_MESSAGE })
    expect(terminalChunk(chunks)).toBeUndefined()
  })

  test('keeps a normal content stream ending with finish_reason stop', async () => {
    const chunks = await collectSse('{"content":"Hello"}')

    expect(textOf(chunks)).toBe('Hello')
    expect(errorChunk(chunks)).toBeUndefined()
    const terminal = terminalChunk(chunks)
    expect(terminal.choices[0].finish_reason).toBe('stop')
    expect(terminal.usage).toBeDefined()
  })

  test('keeps a tool-call-only stream ending with finish_reason tool_calls', async () => {
    const chunks = await collectSse(
      '{"name":"get_weather","toolUseId":"tool-use-1","input":"query","stop":true}'
    )

    expect(errorChunk(chunks)).toBeUndefined()
    const terminal = terminalChunk(chunks)
    expect(terminal.choices[0].finish_reason).toBe('tool_calls')
    expect(chunks.filter((chunk) => chunk.choices?.[0]?.delta?.tool_calls).length).toBeGreaterThan(0)
  })

  test('does not treat a thinking-tag reasoning-only stream as empty', async () => {
    const chunks = await collectSse('{"content":"<thinking>deliberating</thinking>"}')

    expect(reasoningOf(chunks)).toBe('deliberating')
    expect(errorChunk(chunks)).toBeUndefined()
    const terminal = terminalChunk(chunks)
    expect(terminal.choices[0].finish_reason).toBe('stop')
  })
})
