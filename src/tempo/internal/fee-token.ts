import type { Address, Client } from 'viem'
import { Actions, TokenId } from 'viem/tempo'

import * as TempoAddress from './address.js'
import * as defaults from './defaults.js'

function pushUnique(
  tokens: Address[],
  token: Address | undefined,
  allowedTokens?: readonly Address[] | undefined,
) {
  if (!token) return
  if (
    allowedTokens &&
    !allowedTokens.some((allowedToken) => TempoAddress.isEqual(allowedToken, token))
  )
    return
  if (tokens.some((t) => TempoAddress.isEqual(t, token))) return
  tokens.push(token)
}

async function hasBalance(client: Client, account: Address, token: Address): Promise<boolean> {
  try {
    return (await Actions.token.getBalance(client as never, { account, token })).amount > 0n
  } catch {
    return false
  }
}

function getChainFeeToken(client: Client): Address | undefined {
  const feeToken = (client.chain as { feeToken?: Address | bigint | undefined } | undefined)
    ?.feeToken
  if (feeToken) return TokenId.toAddress(feeToken)

  const chainId = client.chain?.id
  return chainId ? defaults.currency[chainId as keyof typeof defaults.currency] : undefined
}

/**
 * Resolves a funded fee token from account, chain, and caller-supplied preferences.
 *
 * `prioritizeCandidates` checks candidate tokens before account and chain
 * preferences. `allowedTokens` limits every preference to the caller's policy.
 */
export async function resolveFeeToken(parameters: {
  account: Address
  allowedTokens?: readonly Address[] | undefined
  candidateTokens?: readonly Address[] | undefined
  client: Client
  prioritizeCandidates?: boolean | undefined
}): Promise<Address | undefined> {
  const { account, allowedTokens, candidateTokens, client, prioritizeCandidates } = parameters
  const tokens: Address[] = []

  if (prioritizeCandidates)
    for (const token of candidateTokens ?? []) pushUnique(tokens, token, allowedTokens)

  const userToken = await Actions.fee
    .getUserToken(client as never, { account })
    .then((token) => token?.address as Address | undefined)
    .catch(() => undefined)
  pushUnique(tokens, userToken, allowedTokens)
  pushUnique(tokens, getChainFeeToken(client), allowedTokens)
  if (!prioritizeCandidates)
    for (const token of candidateTokens ?? []) pushUnique(tokens, token, allowedTokens)

  for (const token of tokens) {
    if (await hasBalance(client, account, token)) return token
  }

  return tokens[0]
}
