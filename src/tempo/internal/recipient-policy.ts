import { isAddress, type Address, type Client } from 'viem'
import { readContract } from 'viem/actions'
import { Abis, Addresses } from 'viem/tempo'

/** How long an authorized recipient is cached before its policy is read again. */
const authorizedTtlMs = 5 * 60_000

/** Authorized recipients by chain, currency and recipient, with when each check expires. */
const authorized = new Map<string, number>()

/**
 * Returns whether a currency's TIP-403 transfer policy lets every recipient receive it, such as
 * whether a payee is an approved MACH merchant. A payment in that currency to a forbidden
 * recipient would revert, so the server should not offer it.
 *
 * Only custom policies (ID 2 and above) restrict recipients, and only a definitive `false` from
 * the chain returns false. Unreadable policies count as authorized.
 * Authorized recipients are cached for five minutes, so a revoked one stops being offered MACH
 * soon after; until then a client's pre-signing simulation fails and it pays the challenge
 * currency instead. Rejected recipients are checked again on every call.
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
  const recipients = [
    ...new Set(
      parameters.recipients
        .filter(
          (recipient): recipient is Address =>
            recipient !== undefined && isAddress(recipient, { strict: false }),
        )
        .map((recipient) => recipient.toLowerCase() as Address),
    ),
  ].filter((recipient) => !((authorized.get(key(chainId, currency, recipient)) ?? 0) > Date.now()))
  if (recipients.length === 0) return true

  let policyId: bigint
  try {
    policyId = (await readContract(client, {
      abi: Abis.tip20,
      address: currency,
      functionName: 'transferPolicyId',
    })) as bigint
  } catch {
    return true
  }
  // Built-in policies 0 (reject all) and 1 (allow all) do not restrict who receives.
  if (policyId < 2n) return true

  for (const recipient of recipients) {
    let allowed: boolean
    try {
      allowed = (await readContract(client, {
        abi: Abis.tip403Registry,
        address: Addresses.tip403Registry,
        functionName: 'isAuthorizedRecipient',
        args: [policyId, recipient],
      })) as boolean
    } catch {
      continue
    }
    if (!allowed) return false
    authorized.set(key(chainId, currency, recipient), Date.now() + authorizedTtlMs)
  }
  return true
}

function key(chainId: number | undefined, currency: string, recipient: string) {
  return `${chainId ?? ''}:${currency.toLowerCase()}:${recipient.toLowerCase()}`
}
