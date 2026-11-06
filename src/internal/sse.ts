/** An event dispatched from a `text/event-stream` body. */
export type Event = {
  /** The event's data: its `data` field values joined by `\n`. */
  data: string
  /** The event's type: its last `event` field value, or `'message'` when it has none. */
  event: string
}

/**
 * Creates an incremental parser for a `text/event-stream` body, as the WHATWG HTML
 * spec interprets one. Feed it decoded text chunks split anywhere; it calls `onEvent`
 * for each event a blank line ends. Lines end in `\n`, `\r\n` or `\r`; comments (`:`),
 * `id`, `retry` and unknown fields are ignored, and an event that never ends is not
 * dispatched.
 *
 * @see https://html.spec.whatwg.org/multipage/server-sent-events.html#event-stream-interpretation
 */
export function createParser(onEvent: (event: Event) => void) {
  let buffer = ''
  let started = false
  let skipLineFeed = false
  let data: string | undefined
  let event = ''

  function parseLine(line: string) {
    if (line === '') {
      if (data !== undefined) onEvent({ data, event: event || 'message' })
      data = undefined
      event = ''
      return
    }
    if (line.startsWith(':')) return
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'data') data = data === undefined ? value : `${data}\n${value}`
    else if (field === 'event') event = value
  }

  return {
    /** Parses the next chunk of the stream. */
    feed(chunk: string) {
      if (!started && chunk) {
        started = true
        if (chunk.startsWith('\uFEFF')) chunk = chunk.slice(1)
      }
      // A `\r` ending the last chunk may be the first half of a `\r\n`.
      if (skipLineFeed && chunk) {
        skipLineFeed = false
        if (chunk.startsWith('\n')) chunk = chunk.slice(1)
      }
      buffer += chunk
      if (!/[\r\n]/.test(chunk)) return
      let start = 0
      const terminator = /\r\n?|\n/g
      for (let match = terminator.exec(buffer); match; match = terminator.exec(buffer)) {
        parseLine(buffer.slice(start, match.index))
        start = terminator.lastIndex
        if (match[0] === '\r' && start === buffer.length) skipLineFeed = true
      }
      buffer = buffer.slice(start)
    },
  }
}
