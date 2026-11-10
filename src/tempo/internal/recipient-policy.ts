import { isAddress, type Address, type Client } from 'viem'
import { readContract } from 'viem/actions'
import { Abis, Addresses } from 'viem/tempo'

/** How long an authorized recipient is cached before its policy is read again. */
const authorizedTtlMs = 5 * 60_000

/** How long a rejected recipient is cached, so unpaid 402s don't read the chain every time. */
const rejectedTtlMs = 60_000

/** Policy results by chain, currency and recipient, with when each expires. */
const cache = new Map<string, { allowed: boolean; expires: number }>()

/**
 * Returns whether a currency's TIP-403 transfer policy lets every recipient receive it, such as
 * whether a payee is an approved MACH merchant. A payment in that currency to a forbidden
 * recipient would revert, so the server should not offer it.
 *
 * Policy 1 allows every recipient and policy 0 rejects them all; custom policies (ID 2 and above)
 * are asked per recipient. A policy that cannot be read returns false, so the server keeps offering
 * only the advertised currency rather than a MACH route that may not land.
 * Authorized recipients are cached for five minutes and rejected ones for one minute, so a change
 * to the policy takes effect soon after; until then a client's pre-signing simulation fails and it
 * pays the challenge currency instead.
 */
export async function areRecipientsAuthorized(
  client: Client,
  parameters: {
    chainId: number | undefined
    currency: string
    recipients: readonly (string | undefined)[]
  },
): Promise<boolean> {
  const { chainId, currency } = parameters
  if (!isAddress(currency, { strict: false })) return true
  const now = Date.now()
  const recipients: Address[] = []
  for (const recipient of new Set(
    parameters.recipients
      .filter(
        (recipient): recipient is Address =>
          recipient !== undefined && isAddress(recipient, { strict: false }),
      )
      .map((recipient) => recipient.toLowerCase() as Address),
  )) {
    const cached = cache.get(key(chainId, currency, recipient))
    if (cached && cached.expires > now) {
      if (!cached.allowed) return false
    } else recipients.push(recipient)
  }
  if (recipients.length === 0) return true

  let policyId: bigint
  try {
    policyId = (await readContract(client, {
      abi: Abis.tip20,
      address: currency,
      functionName: 'transferPolicyId',
    })) as bigint
  } catch {
    return false
  }

  for (const recipient of recipients) {
    let allowed: boolean
    if (policyId === 0n) allowed = false
    else if (policyId === 1n) allowed = true
    else
      try {
        allowed = (await readContract(client, {
          abi: Abis.tip403Registry,
          address: Addresses.tip403Registry,
          functionName: 'isAuthorizedRecipient',
          args: [policyId, recipient],
        })) as boolean
      } catch {
        return false
      }
    cache.set(key(chainId, currency, recipient), {
      allowed,
      expires: now + (allowed ? authorizedTtlMs : rejectedTtlMs),
    })
    if (!allowed) return false
  }
  return true
}

function key(chainId: number | undefined, currency: string, recipient: string) {
  return `${chainId ?? ''}:${currency.toLowerCase()}:${recipient.toLowerCase()}`
}
