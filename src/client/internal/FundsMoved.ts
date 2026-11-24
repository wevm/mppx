// A global symbol, so errors from another copy of mppx in the same bundle are recognized too.
const fundsMayHaveMoved = Symbol.for('mppx.client.fundsMayHaveMoved')

/**
 * Marks an error a method throws after it sent or settled a payment, such as a Zone withdrawal
 * whose credential could not be built: funds may have moved, so the client's spending limits keep
 * counting the payment instead of releasing it. The error's type and message are unchanged.
 */
export function mark<const error extends Error>(error: error): error {
  Object.defineProperty(error, fundsMayHaveMoved, { value: true })
  return error
}

/** Whether {@link mark} marked `error`. */
export function has(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { [fundsMayHaveMoved]?: true })[fundsMayHaveMoved] === true
  )
}
