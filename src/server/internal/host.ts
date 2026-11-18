/** Whether an incoming Host matches an operator-controlled exact allowlist, including its port. */
export function isAllowed(
  host: string | undefined,
  allowedHosts: readonly string[] | undefined,
): boolean {
  if (allowedHosts === undefined) return true
  return (
    host !== undefined &&
    allowedHosts.some((allowed) => allowed.toLowerCase() === host.toLowerCase())
  )
}
