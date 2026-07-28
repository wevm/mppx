import { stripePreviewVersion } from '../../internal/constants.js'

/**
 * Resolves a deposit address for a given network from the Stripe API.
 * Fetches an existing address or creates a new one if none exist.
 */
export async function resolveDepositAddress(
  secretKey: string,
  network: string,
): Promise<string | null> {
  const headers = {
    Authorization: `Basic ${btoa(`${secretKey}:`)}`,
    'Content-Type': 'application/x-www-form-urlencoded',
    'Stripe-Version': stripePreviewVersion,
  }

  try {
    const listResponse = await fetch(
      `https://api.stripe.com/v1/crypto/deposit_addresses?network=${network}&limit=1`,
      { headers },
    )
    if (listResponse.ok) {
      const list = (await listResponse.json()) as { data?: { address: string }[] }
      if (list.data && list.data.length > 0) return list.data[0]!.address
    }

    const createResponse = await fetch('https://api.stripe.com/v1/crypto/deposit_addresses', {
      method: 'POST',
      headers,
      body: new URLSearchParams({ network }),
    })
    if (!createResponse.ok) return null

    const created = (await createResponse.json()) as { address: string }
    return created.address
  } catch {
    return null
  }
}
