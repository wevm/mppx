import { createParser as createReferenceParser } from 'eventsource-parser'
import { describe, expect, test } from 'vp/test'

import { createParser, type Event } from './sse.js'

function parse(chunks: readonly string[]): Event[] {
  const events: Event[] = []
  const parser = createParser((event) => events.push(event))
  for (const chunk of chunks) parser.feed(chunk)
  return events
}

describe('createParser', () => {
  test('dispatches an event on a blank line', () => {
    expect(parse(['data: hello\n\n'])).toEqual([{ data: 'hello', event: 'message' }])
  })

  test('accepts \\n, \\r\\n and \\r line endings', () => {
    const expected = [
      { data: 'a', event: 'message' },
      { data: 'b', event: 'message' },
    ]
    expect(parse(['data: a\n\ndata: b\n\n'])).toEqual(expected)
    expect(parse(['data: a\r\n\r\ndata: b\r\n\r\n'])).toEqual(expected)
    expect(parse(['data: a\r\rdata: b\r\r'])).toEqual(expected)
    expect(parse(['data: a\r\n\ndata: b\r\r\n'])).toEqual(expected)
  })

  test('joins multi-line data with \\n', () => {
    expect(parse(['data: a\ndata:\ndata: c\n\n'])).toEqual([{ data: 'a\n\nc', event: 'message' }])
  })

  test('reads the event type', () => {
    expect(parse(['event: ping\ndata: 1\n\ndata: 2\n\n'])).toEqual([
      { data: '1', event: 'ping' },
      { data: '2', event: 'message' },
    ])
    expect(parse(['event: ping\nevent:\ndata: 1\n\n'])).toEqual([{ data: '1', event: 'message' }])
  })

  test('strips only one leading space from a value', () => {
    expect(parse(['data:no-space\n\ndata:  two\n\n'])).toEqual([
      { data: 'no-space', event: 'message' },
      { data: ' two', event: 'message' },
    ])
  })

  test('ignores comments, other fields and events without data', () => {
    expect(
      parse([': keep-alive\n\nid: 1\nretry: 10\nfoo: bar\nevent: x\n\n:c\ndata: d\nid: 2\n\n']),
    ).toEqual([{ data: 'd', event: 'message' }])
  })

  test('dispatches empty data', () => {
    expect(parse(['data\n\ndata:\n\n'])).toEqual([
      { data: '', event: 'message' },
      { data: '', event: 'message' },
    ])
  })

  test('does not dispatch an event that never ends', () => {
    expect(parse(['data: a\n'])).toEqual([])
    expect(parse(['data: a'])).toEqual([])
  })

  test('strips a leading byte order mark', () => {
    expect(parse(['', '\uFEFFdata: a\n\n'])).toEqual([{ data: 'a', event: 'message' }])
    expect(parse(['data: \uFEFF\n\n'])).toEqual([{ data: '\uFEFF', event: 'message' }])
  })

  test('handles chunks split anywhere', () => {
    const stream = 'event: e\r\ndata: {"a":1}\r\ndata: 2\r\n\r\n: c\rdata: x\r\rdata: y\n\n'
    const expected = [
      { data: '{"a":1}\n2', event: 'e' },
      { data: 'x', event: 'message' },
      { data: 'y', event: 'message' },
    ]
    expect(parse([stream])).toEqual(expected)
    expect(parse([...stream])).toEqual(expected)
    for (let i = 0; i <= stream.length; i++)
      for (let j = i; j <= stream.length; j++)
        expect(parse([stream.slice(0, i), stream.slice(i, j), stream.slice(j)])).toEqual(expected)
  })
})

/** Parses `chunks` with the reference parser the internal one replaced, as Mcp.ts consumed it. */
function reference(chunks: readonly string[]): Event[] {
  const events: Event[] = []
  const parser = createReferenceParser({
    onEvent: (event) => events.push({ data: event.data, event: event.event ?? 'message' }),
  })
  for (const chunk of chunks) parser.feed(chunk)
  parser.reset({ consume: true })
  return events
}

/** Every way to cut `stream` into two chunks, plus one chunk per character. */
function splits(stream: string): string[][] {
  const result = [[stream], [...stream]]
  for (let i = 0; i <= stream.length; i++) result.push([stream.slice(0, i), stream.slice(i)])
  return result
}

const message = (data: string) => ({ data, event: 'message' })

// https://html.spec.whatwg.org/multipage/server-sent-events.html#event-stream-interpretation
// and https://github.com/web-platform-tests/wpt/tree/master/eventsource (format-*.htm).
const longComment = 'x'.repeat(2 * 1024)
const specCases: { name: string; stream: string; expected: Event[] }[] = [
  {
    name: 'spec: multi-line data',
    stream: 'data: YHOO\ndata: +2\ndata: 10\n\n',
    expected: [message('YHOO\n+2\n10')],
  },
  {
    name: 'spec: comments, ids and one leading space',
    stream:
      ': test stream\n\ndata: first event\nid: 1\n\ndata:second event\nid\n\ndata:  third event\n\n',
    expected: [message('first event'), message('second event'), message(' third event')],
  },
  {
    name: 'spec: empty data and a final unterminated block',
    stream: 'data\n\ndata\ndata\n\ndata:',
    expected: [message(''), message('\n')],
  },
  {
    name: 'spec: a space after the colon is optional',
    stream: 'data:test\n\ndata: test\n\n',
    expected: [message('test'), message('test')],
  },
  {
    name: 'spec: event types',
    stream:
      'event: add\ndata: 73857293\n\nevent: remove\ndata: 2153\n\nevent: add\ndata: 113411\n\n',
    expected: [
      { data: '73857293', event: 'add' },
      { data: '2153', event: 'remove' },
      { data: '113411', event: 'add' },
    ],
  },
  {
    name: 'wpt format-bom',
    stream: '\uFEFFdata:1\n\n\uFEFFdata:2\n\ndata:3\n\n',
    expected: [message('1'), message('3')],
  },
  {
    name: 'wpt format-bom-2',
    stream: '\uFEFF\uFEFFdata:1\n\ndata:2\n\ndata:3\n\n',
    expected: [message('2'), message('3')],
  },
  {
    name: 'wpt format-comments',
    stream: `data:1\r:\0\n:\r\ndata:2\n:${longComment}\rdata:3\n:data:fail\r:${longComment}\ndata:4\n\n`,
    expected: [message('1\n2\n3\n4')],
  },
  {
    name: 'wpt format-data-before-final-empty-line',
    stream: 'retry:1000\ndata:test1\n\nid:test\ndata:test2',
    expected: [message('test1')],
  },
  {
    name: 'wpt format-field-data',
    stream: 'data:\n\ndata\ndata\n\ndata:test\n\n',
    expected: [message(''), message('\n'), message('test')],
  },
  {
    name: 'wpt format-field-event',
    stream: 'event:test\ndata:x\n\ndata:x\n\n',
    expected: [{ data: 'x', event: 'test' }, message('x')],
  },
  {
    name: 'wpt format-field-event-empty',
    stream: 'event: \ndata:data\n\n',
    expected: [message('data')],
  },
  {
    name: 'wpt format-field-id',
    stream: 'id:1\ndata:x\n\nid:\ndata:y\n\nid:\0\ndata:z\n\n',
    expected: [message('x'), message('y'), message('z')],
  },
  {
    name: 'wpt format-field-parsing',
    stream:
      'data:\0\ndata:  2\rData:1\ndata\0:2\ndata:1\r\0data:4\nda-ta:3\rdata_5\ndata:3\rdata:\r\n data:32\ndata:4\n\n',
    expected: [message('\0\n 2\n1\n3\n\n4')],
  },
  {
    name: 'wpt format-field-retry',
    stream: 'retry:03000\ndata:x\n\nretry:1000x\ndata:y\n\nretry\ndata:z\n\n',
    expected: [message('x'), message('y'), message('z')],
  },
  {
    name: 'wpt format-field-unknown',
    stream: 'data:test\n data\ndata\nfoobar:xxx\njustsometext\n:thisisacommentyay\ndata:test\n\n',
    expected: [message('test\n\ntest')],
  },
  {
    name: 'wpt format-leading-space',
    stream: 'data:\ttest\rdata: \ndata:test\n\n',
    expected: [message('\ttest\n\ntest')],
  },
  {
    name: 'wpt format-newlines',
    stream: 'data:test\r\ndata\ndata:test\r\n\r',
    expected: [message('test\n\ntest')],
  },
  {
    name: 'wpt format-null-character',
    stream: 'data:\0\n\n\n\n',
    expected: [message('\0')],
  },
  {
    name: 'wpt format-utf-8',
    stream: 'data:ok\u2026\n\n',
    expected: [message('ok\u2026')],
  },
]

describe('spec and web-platform-tests cases', () => {
  test.each(specCases)('$name', ({ stream, expected }) => {
    for (const chunks of splits(stream)) {
      expect(parse(chunks)).toEqual(expected)
      expect(reference(chunks)).toEqual(expected)
    }
  })
})

describe('edge cases', () => {
  test.each([
    {
      name: 'NUL in data, event and field names',
      stream: 'event:a\0b\ndata\0:x\ndata:\0\0\n\n',
      expected: [{ data: '\0\0', event: 'a\0b' }],
    },
    {
      name: 'colons inside values',
      stream: 'data: a:b: c\ndata::\n\n',
      expected: [message('a:b: c\n:')],
    },
    {
      name: 'only one leading space is stripped',
      stream: 'data:  a \nevent:  e\n\n',
      expected: [{ data: ' a ', event: ' e' }],
    },
    { name: 'a tab is not stripped', stream: 'data:\ta\n\n', expected: [message('\ta')] },
    {
      name: 'case-sensitive field names',
      stream: 'Data: x\nEVENT: y\nDATA: z\ndata: d\n\n',
      expected: [message('d')],
    },
    {
      name: 'a field name with a trailing space is unknown',
      stream: 'data : x\nevent :y\ndata: d\n\n',
      expected: [message('d')],
    },
    {
      name: 'U+2028, U+2029 and NEL are not line breaks',
      stream: 'data: a\u2028b\u2029c\u0085d\n\n',
      expected: [message('a\u2028b\u2029c\u0085d')],
    },
    {
      name: 'an event line without a colon resets the type',
      stream: 'event: x\nevent\ndata: d\n\n',
      expected: [message('d')],
    },
    {
      name: 'the last event field wins',
      stream: 'event: a\ndata: 1\nevent: b\n\n',
      expected: [{ data: '1', event: 'b' }],
    },
    {
      name: 'an explicit message type',
      stream: 'event: message\ndata: 1\n\n',
      expected: [message('1')],
    },
    {
      name: 'the event type resets after an event without data',
      stream: 'event: x\n\ndata: 1\n\n',
      expected: [message('1')],
    },
    {
      name: 'data and type reset after each event',
      stream: 'event: x\ndata: 1\n\ndata: 2\n\n',
      expected: [{ data: '1', event: 'x' }, message('2')],
    },
    { name: 'blank lines without data dispatch nothing', stream: '\n\n\r\n\r\r\n\n', expected: [] },
    {
      name: 'a BOM after the start is not stripped',
      stream: 'data: 1\n\n\uFEFFdata: 2\n\n',
      expected: [message('1')],
    },
    {
      name: 'mixed line endings',
      stream: 'data: a\rdata: b\r\ndata: c\n\r\n',
      expected: [message('a\nb\nc')],
    },
    {
      name: 'CR CR is two line breaks',
      stream: 'data: a\r\rdata: b\r\n\r\n',
      expected: [message('a'), message('b')],
    },
    {
      name: 'LF CR is two line breaks',
      stream: 'data: a\n\rdata: b\n\n',
      expected: [message('a'), message('b')],
    },
    {
      name: 'astral characters',
      stream: 'event: 😀\ndata: 𝄞 😀\n\n',
      expected: [{ data: '𝄞 😀', event: '😀' }],
    },
  ])('$name', ({ stream, expected }) => {
    for (const chunks of splits(stream)) {
      expect(parse(chunks)).toEqual(expected)
      expect(reference(chunks)).toEqual(expected)
    }
  })

  test('a CR ending a chunk joins a LF starting the next one', () => {
    expect(parse(['data: a\r', '\ndata: b\r', '\n\r', '\n'])).toEqual([message('a\nb')])
    expect(parse(['data: a\r', '', '', '\ndata: b\r\n\r\n'])).toEqual([message('a\nb')])
    expect(parse(['data: a\r', '\n', '\n'])).toEqual([message('a')])
  })

  test('a CR ending a chunk does not swallow anything else', () => {
    expect(parse(['data: a\r', '\r'])).toEqual([message('a')])
    expect(parse(['data: a\r', 'data: b\r', '\r'])).toEqual([message('a\nb')])
    expect(parse(['data: a\r', '\n', '\ndata: b\n\n'])).toEqual([message('a'), message('b')])
    expect(parse(['data: a\r\n', '\n'])).toEqual([message('a')])
  })

  test('a CR ending a chunk swallows only one LF', () => {
    expect(parse(['data: a\r', '\n\n'])).toEqual([message('a')])
    expect(parse(['data: a\r', '\n', 'data: b\r', '\n', '\r', '\n'])).toEqual([message('a\nb')])
  })

  test('strips only the first BOM of the stream', () => {
    expect(parse(['\uFEFF', '\uFEFFdata: a\n\ndata: b\n\n'])).toEqual([message('b')])
    expect(parse(['', '', '\uFEFF', 'data: a\n\n'])).toEqual([message('a')])
    expect(parse(['data: a\n\n', '\uFEFFdata: b\n\n'])).toEqual([message('a')])
  })

  test('keeps a line without a line break until one arrives', () => {
    const events: Event[] = []
    const parser = createParser((event) => events.push(event))
    parser.feed('data: ')
    for (let i = 0; i < 1000; i++) parser.feed('x')
    expect(events).toEqual([])
    parser.feed('\n')
    expect(events).toEqual([])
    parser.feed('\n')
    expect(events).toEqual([message('x'.repeat(1000))])
  })

  test('dispatches events as soon as their blank line arrives', () => {
    const events: Event[] = []
    const parser = createParser((event) => events.push(event))
    parser.feed('data: 1\n')
    expect(events).toEqual([])
    parser.feed('\ndata: 2\n')
    expect(events).toEqual([message('1')])
    parser.feed('\r')
    expect(events).toEqual([message('1'), message('2')])
  })
})

describe('large and adversarial streams', () => {
  test('parses a 5 MB data line in linear time', () => {
    const size = 5 * 1024 * 1024
    const stream = `data: ${'x'.repeat(size)}\n\n`
    for (const chunkSize of [1024, 64 * 1024]) {
      const events: Event[] = []
      const parser = createParser((event) => events.push(event))
      const start = performance.now()
      for (let i = 0; i < stream.length; i += chunkSize) parser.feed(stream.slice(i, i + chunkSize))
      expect(performance.now() - start).toBeLessThan(2_000)
      expect(events).toHaveLength(1)
      expect(events[0]!.data.length).toBe(size)
    }
  })

  test('parses a 1 MB data line fed one character at a time in linear time', () => {
    const value = 'y'.repeat(1024 * 1024)
    const events: Event[] = []
    const parser = createParser((event) => events.push(event))
    const start = performance.now()
    parser.feed('data:')
    for (let i = 0; i < value.length; i++) parser.feed('y')
    parser.feed('\r\n\r\n')
    expect(performance.now() - start).toBeLessThan(2_000)
    expect(events).toEqual([message(value)])
  })

  test('parses 100,000 small events in linear time', () => {
    const count = 100_000
    let stream = ''
    for (let i = 0; i < count; i++) stream += `event: e\ndata: ${i}\r\n\r\n`
    for (const chunkSize of [7, 4096, stream.length]) {
      let seen = 0
      let last = ''
      const parser = createParser((event) => {
        seen++
        last = event.data
      })
      const start = performance.now()
      for (let i = 0; i < stream.length; i += chunkSize) parser.feed(stream.slice(i, i + chunkSize))
      expect(performance.now() - start).toBeLessThan(3_000)
      expect(seen).toBe(count)
      expect(last).toBe(String(count - 1))
    }
  })

  test('dispatches nothing for a stream without line breaks', () => {
    const events: Event[] = []
    const parser = createParser((event) => events.push(event))
    const start = performance.now()
    for (let i = 0; i < 1024; i++) parser.feed(`data: ${'z'.repeat(1024)}`)
    expect(performance.now() - start).toBeLessThan(2_000)
    expect(events).toEqual([])
  })

  test('handles many lone CRs split across chunks', () => {
    const events: Event[] = []
    const parser = createParser((event) => events.push(event))
    for (let i = 0; i < 10_000; i++) {
      parser.feed(`data: ${i}\r`)
      parser.feed('\n\r')
      parser.feed('\n')
    }
    expect(events).toHaveLength(10_000)
    expect(events.at(-1)).toEqual(message('9999'))
  })
})
