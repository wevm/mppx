import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import * as Sse from './Sse.js'

function createChunkedResponse(chunks: Uint8Array[]): Response {
  let index = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(chunks[index]!)
        index++
      } else {
        controller.close()
      }
    },
  })
  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

function splitAtPositions(str: string, positions: number[]): Uint8Array[] {
  const encoder = new TextEncoder()
  const sorted = [...new Set([0, ...positions, str.length])]
    .filter((p) => p >= 0 && p <= str.length)
    .sort((a, b) => a - b)
  const chunks: Uint8Array[] = []
  for (let i = 0; i < sorted.length - 1; i++) {
    const chunk = str.slice(sorted[i], sorted[i + 1])
    if (chunk.length > 0) chunks.push(encoder.encode(chunk))
  }
  return chunks
}

async function collectData(response: Response): Promise<string[]> {
  const results: string[] = []
  for await (const data of Sse.iterateData(response)) {
    results.push(data)
  }
  return results
}

describe('parseEvent', () => {
  test('never throws on arbitrary message-type input', () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        const result = Sse.parseEvent(input)
        if (result !== null) {
          expect(result.type).toBe('message')
          expect(typeof result.data).toBe('string')
        }
      }),
      { numRuns: 10_000 },
    )
  })

  test('parseEvent with valid SSE format', () => {
    const sseMessageArb = fc
      .array(
        fc.string().filter((s) => !s.includes('\n')),
        { minLength: 1, maxLength: 5 },
      )
      .map((lines) => lines.map((l) => `data: ${l}`).join('\n'))

    fc.assert(
      fc.property(sseMessageArb, (raw) => {
        const result = Sse.parseEvent(raw)
        expect(result).not.toBeNull()
        expect(result!.type).toBe('message')
        const expectedData = raw
          .split('\n')
          .map((l) => l.slice(6))
          .join('\n')
        expect(result!.data).toBe(expectedData)
      }),
      { numRuns: 5_000 },
    )
  })
})

describe('iterateData', () => {
  const sseEventArb = fc
    .array(
      fc.string().filter((s) => !s.includes('\n\n') && !s.includes('\n')),
      { minLength: 1, maxLength: 3 },
    )
    .map((lines) => lines.map((l) => `data: ${l}`).join('\n'))

  const sseStreamArb = fc
    .array(sseEventArb, { minLength: 1, maxLength: 5 })
    .map((events) => events.join('\n\n') + '\n\n')

  test('chunk boundary invariance', async () => {
    await fc.assert(
      fc.asyncProperty(
        sseStreamArb,
        fc.array(fc.nat(), { minLength: 1, maxLength: 10 }),
        async (stream, positions) => {
          const encoder = new TextEncoder()

          const singleChunk = createChunkedResponse([encoder.encode(stream)])
          const singleResult = await collectData(singleChunk)

          const boundedPositions = positions.map((p) => p % (stream.length + 1))
          const chunks = splitAtPositions(stream, boundedPositions)
          const multiChunk = createChunkedResponse(chunks)
          const multiResult = await collectData(multiChunk)

          expect(multiResult).toEqual(singleResult)
        },
      ),
      { numRuns: 1_000 },
    )
  })

  test('iterateData never throws on arbitrary chunked input', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.uint8Array({ minLength: 1, maxLength: 100 }), {
          minLength: 1,
          maxLength: 5,
        }),
        async (chunks) => {
          const response = createChunkedResponse(chunks)
          const results: string[] = []
          for await (const data of Sse.iterateData(response)) {
            results.push(data)
          }
          for (const item of results) {
            expect(typeof item).toBe('string')
          }
        },
      ),
      { numRuns: 5_000 },
    )
  })
})
