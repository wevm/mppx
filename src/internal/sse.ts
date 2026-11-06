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
    const colon = line.indexOf(':')
    if (colon === 0) return
    const field = colon === -1 ? line : line.slice(0, colon)
    if (field !== 'data' && field !== 'event') return
    let value = ''
    if (colon !== -1) value = line.slice(line.charCodeAt(colon + 1) === 32 ? colon + 2 : colon + 1)
    if (field === 'event') event = value
    else data = data === undefined ? value : data + '\n' + value
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
      if (chunk.indexOf('\n') === -1 && chunk.indexOf('\r') === -1) return
      // Scan with indexOf rather than a global RegExp: it is several times faster on
      // line-dense bodies.
      let start = 0
      let lineFeed = buffer.indexOf('\n')
      let carriageReturn = buffer.indexOf('\r')
      while (lineFeed !== -1 || carriageReturn !== -1) {
        const end =
          lineFeed === -1
            ? carriageReturn
            : carriageReturn === -1
              ? lineFeed
              : Math.min(lineFeed, carriageReturn)
        parseLine(buffer.slice(start, end))
        start = end + 1
        if (end === carriageReturn) {
          if (start === buffer.length) skipLineFeed = true
          else if (lineFeed === start) start++
          carriageReturn = buffer.indexOf('\r', start)
        }
        if (lineFeed !== -1 && lineFeed < start) lineFeed = buffer.indexOf('\n', start)
      }
      buffer = buffer.slice(start)
    },
  }
}
