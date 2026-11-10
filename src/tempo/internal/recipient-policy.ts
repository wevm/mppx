import { isAddress, type Address, type Client } from 'viem'
import { readContract } from 'viem/actions'
import { Abis, Addresses } from 'viem/tempo'

const authorized = new Set<string>()

/**
 * Throws when a currency's TIP-403 transfer policy forbids one of the recipients, such as a
 * MACH offer whose payee is not an approved merchant. Payments to that recipient would revert,
 * so the server should not advertise the currency.
 *
 * Only custom policies (ID 2 and above) restrict recipients, and only a definitive `false` from
 * the chain throws. Unreadable policies do not block payment.
 * Authorized recipients are cached for the process; rejected ones are checked again so a newly
 * approved recipient starts working without a restart.
 */
export async function assertRecipientsAuthorized(
  client: Client,
  parameters: {
    chainId: number | undefined
    currency: string
    recipients: readonly (string | undefined)[]
  },
): Promise<void> {
  const { chainId, currency } = parameters
  if (!isAddress(currency, { strict: false })) return
  const recipients = [
    ...new Set(
      parameters.recipients
        .filter(
          (recipient): recipient is Address =>
            recipient !== undefined && isAddress(recipient, { strict: false }),
        )
        .map((recipient) => recipient.toLowerCase() as Address),
    ),
  ].filter((recipient) => !authorized.has(key(chainId, currency, recipient)))
  if (recipients.length === 0) return

  let policyId: bigint
  try {
    policyId = (await readContract(client, {
      abi: Abis.tip20,
      address: currency,
      functionName: 'transferPolicyId',
    })) as bigint
  } catch {
    return
  }
  // Built-in policies 0 (reject all) and 1 (allow all) do not restrict who receives.
  if (policyId < 2n) return

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
    if (!allowed)
      throw new Error(
        `Recipient ${recipient} cannot receive ${currency}: its transfer policy forbids it. Remove the currency or use an authorized recipient.`,
      )
    authorized.add(key(chainId, currency, recipient))
  }
}

function key(chainId: number | undefined, currency: string, recipient: string) {
  return `${chainId ?? ''}:${currency.toLowerCase()}:${recipient.toLowerCase()}`
}
