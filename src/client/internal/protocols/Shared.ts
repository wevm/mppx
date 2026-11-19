import * as Constants from '../../../Constants.js'
import * as x402_Types from '../../../x402/Types.js'

/** HTTP status that signals a native payment challenge. */
export const paymentRequiredStatus = 402

/** Credential headers purged before a fresh credential is attached. */
const credentialHeaders = [
  Constants.Headers.authorization,
  Constants.Headers.paymentAuthorization,
  x402_Types.paymentRequiredHeader,
  x402_Types.paymentResponseHeader,
  x402_Types.paymentSignatureHeader,
]

/** Attaches `credential` under `header`, clearing any stale credential headers first. */
export function setCredentialHeader(
  request: RequestInit,
  header: string,
  credential: string,
): RequestInit {
  const headers = new Headers(request.headers)
  for (const stale of credentialHeaders) {
    const value = headers.get(stale)
    if (value === null) continue
    if (!isPaymentField(stale)) {
      headers.delete(stale)
      continue
    }
    // Never erase ordinary application credentials: drop only the Payment members, so a retry
    // never carries a stale credential in the field the new challenge did not select.
    const kept = withoutPaymentMembers(value)
    if (kept === value) continue
    if (kept) headers.set(stale, kept)
    else headers.delete(stale)
  }
  headers.set(header, credential)
  return { ...request, headers }
}

/**
 * Removes the Payment members from a credential field, matched as servers match them
 * (comma-separated, scheme case-insensitive). Returns `value` itself when it holds none.
 */
function withoutPaymentMembers(value: string): string {
  const members = value.split(',').map((member) => member.trim())
  const kept = members.filter((member) => !paymentMember.test(member))
  return kept.length === members.length ? value : kept.filter(Boolean).join(', ')
}

const paymentMember = new RegExp(`^${Constants.Schemes.payment}(?:\\s|$)`, 'i')

function isPaymentField(header: string): boolean {
  return (
    header === Constants.Headers.authorization || header === Constants.Headers.paymentAuthorization
  )
}
