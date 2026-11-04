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
