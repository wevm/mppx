const warned = new Set<string>()

/** Logs `message` with `console.warn` the first time `key` is seen in this process. */
export function warnOnce(key: string, message: string) {
  if (warned.has(key)) return
  warned.add(key)
  console.warn(`[mppx] ${message}`)
}
