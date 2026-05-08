import type { Address, Client } from 'viem'
import { Actions, TokenId } from 'viem/tempo'

import * as TempoAddress from './address.js'
import * as defaults from './defaults.js'

function pushUnique(tokens: Address[], token: Address | undefined) {
  if (!token) return
  if (tokens.some((t) => TempoAddress.isEqual(t, token))) return
  tokens.push(token)
}

async function hasBalance(client: Client, account: Address, token: Address): Promise<boolean> {
  try {
    return (await Actions.token.getBalance(client as never, { account, token })) > 0n
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

export async function resolveFeeToken(parameters: {
  account: Address
  candidateTokens?: readonly Address[] | undefined
  client: Client
}): Promise<Address | undefined> {
  const { account, candidateTokens, client } = parameters
  const tokens: Address[] = []

  const userToken = await Actions.fee
    .getUserToken(client as never, { account })
    .then((token) => token?.address as Address | undefined)
    .catch(() => undefined)
  pushUnique(tokens, userToken)
  pushUnique(tokens, getChainFeeToken(client))
  for (const token of candidateTokens ?? []) pushUnique(tokens, token)

  for (const token of tokens) {
    if (await hasBalance(client, account, token)) return token
  }

  return tokens[0]
}
