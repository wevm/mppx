import { createParser as createReferenceParser } from 'eventsource-parser'
import * as fc from 'fast-check'
import { describe, expect, test } from 'vp/test'

import { createParser, type Event } from './sse.js'

/** Parses `chunks` with the internal parser. */
function parse(chunks: readonly string[]): Event[] {
  const events: Event[] = []
  const parser = createParser((event) => events.push(event))
  for (const chunk of chunks) parser.feed(chunk)
  return events
}

/** Parses `chunks` with eventsource-parser 4.1.1, the parser this one replaced, as Mcp.ts used it. */
function reference(chunks: readonly string[]): Event[] {
  const events: Event[] = []
  const parser = createReferenceParser({
    onEvent: (event) => events.push({ data: event.data, event: event.event ?? 'message' }),
  })
  for (const chunk of chunks) parser.feed(chunk)
  parser.reset({ consume: true })
  return events
}

const lineBreak = /[\r\n]/

// Characters that matter to the grammar, plus arbitrary Unicode (never a line break).
const character = fc.oneof(
  { weight: 6, arbitrary: fc.constantFrom('a', 'd', 'e', 't', 'x', '0', '1', '{', '}', '"', ',') },
  { weight: 4, arbitrary: fc.constantFrom(' ', ':', '\t') },
  {
    weight: 2,
    arbitrary: fc.constantFrom('\0', '\uFEFF', '\u2028', '\u0085', 'é', '…', '支', '😀', '\uD800'),
  },
  {
    weight: 1,
    arbitrary: fc
      .string({ unit: 'binary', minLength: 1, maxLength: 1 })
      .filter((value) => !lineBreak.test(value)),
  },
)
const value = fc.string({ unit: character, maxLength: 12 })
const fieldName = fc.oneof(
  { weight: 8, arbitrary: fc.constantFrom('data', 'event', 'id', 'retry') },
  {
    weight: 2,
    arbitrary: fc.constantFrom('Data', 'EVENT', 'dat', 'datax', 'data ', ' data', '', '\uFEFFdata'),
  },
  { weight: 1, arbitrary: value.filter((name) => !name.includes(':')) },
)
const separator = fc.constantFrom('', ':', ': ', ':  ', '::', ':\t')
const line = fc.oneof(
  {
    weight: 8,
    arbitrary: fc.tuple(fieldName, separator, value).map(([name, sep, text]) => name + sep + text),
  },
  { weight: 2, arbitrary: value.map((text) => `:${text}`) },
  { weight: 5, arbitrary: fc.constant('') },
  { weight: 1, arbitrary: value },
)
const ending = fc.constantFrom('\n', '\r\n', '\r')
const stream = fc
  .record({
    bom: fc.boolean(),
    lines: fc.array(fc.tuple(line, ending), { maxLength: 40 }),
    tail: fc.option(line, { nil: undefined }),
  })
  .map(({ bom, lines, tail }) => (bom ? '\uFEFF' : '') + lines.flat().join('') + (tail ?? ''))

/** Splits `text` at random offsets, including empty chunks. */
const chunked = stream.chain((text) =>
  fc.array(fc.integer({ min: 0, max: text.length }), { maxLength: 12 }).map((cuts) => {
    const offsets = [0, ...cuts.sort((a, b) => a - b), text.length]
    return offsets.slice(1).map((end, index) => text.slice(offsets[index], end))
  }),
)

describe('createParser matches eventsource-parser', () => {
  test('on random streams split at random chunk boundaries', () => {
    fc.assert(
      fc.property(chunked, (chunks) => {
        const expected = reference(chunks)
        expect(parse(chunks)).toEqual(expected)
        expect(parse([chunks.join('')])).toEqual(expected)
      }),
      { numRuns: 20_000 },
    )
  })

  test('on random streams fed one character at a time', () => {
    fc.assert(
      fc.property(stream, (text) => {
        const chunks = text.split('')
        expect(parse(chunks)).toEqual(reference(chunks))
      }),
      { numRuns: 2_000 },
    )
  })

  test('on random streams of line-ending-heavy input', () => {
    const noisy = fc
      .array(
        fc.constantFrom('\r', '\n', '\r\n', 'data', 'data:', ':', ' ', 'x', 'event:e', '\uFEFF'),
        {
          maxLength: 60,
        },
      )
      .map((parts) => parts.join(''))
    fc.assert(
      fc.property(noisy, fc.array(fc.nat(), { maxLength: 8 }), (text, cuts) => {
        const offsets = [
          0,
          ...cuts.map((cut) => cut % (text.length + 1)).sort((a, b) => a - b),
          text.length,
        ]
        const chunks = offsets.slice(1).map((end, index) => text.slice(offsets[index], end))
        expect(parse(chunks)).toEqual(reference(chunks))
      }),
      { numRuns: 10_000 },
    )
  })
})
