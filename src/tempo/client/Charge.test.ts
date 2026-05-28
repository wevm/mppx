import { Challenge, Credential } from 'mppx'
import { createClient } from 'viem'
import { describe, expect, test } from 'vp/test'
import { accounts, asset, chain, http } from '~test/tempo/viem.js'

import * as Methods from '../Methods.js'
import { charge } from './Charge.js'

const account = accounts[1]
const otherAccount = accounts[2]
const chainId = chain.id
const currency = asset
const recipient = '0x2222222222222222222222222222222222222222'

type ChargeRequest = ReturnType<typeof Methods.charge.schema.request.parse>

function createChallenge(
  overrides: Partial<Parameters<typeof Methods.charge.schema.request.parse>[0]> = {},
): Challenge.Challenge<ChargeRequest, 'charge', 'tempo'> {
  const request = Methods.charge.schema.request.parse({
    amount: '0',
    currency,
    decimals: 6,
    recipient,
    ...overrides,
  })
  return Challenge.from({
    id: 'test-challenge-id',
    intent: 'charge',
    method: 'tempo',
    realm: 'api.example.com',
    request,
  }) as Challenge.Challenge<ChargeRequest, 'charge', 'tempo'>
}

describe('tempo.charge client', () => {
  test('behavior: uses client chain ID when challenge omits chainId', async () => {
    const client = createClient({
      account,
      chain,
      transport: http(),
    })
    const method = charge({
      account,
      getClient: () => client,
    })

    const credential = Credential.deserialize(
      await method.createCredential({
        challenge: createChallenge(),
        context: {},
      }),
    )

    expect(credential.source).toBe(`did:pkh:eip155:${chainId}:${account.address}`)
  })

  test('behavior: uses challenge chainId for client resolution and proof source', async () => {
    let requestedChainId: number | undefined
    const challengeChainId = 42431
    const client = createClient({
      account,
      chain,
      transport: http(),
    })
    const method = charge({
      account,
      getClient: (parameters) => {
        requestedChainId = parameters.chainId
        return client
      },
    })

    const credential = Credential.deserialize(
      await method.createCredential({
        challenge: createChallenge({ chainId: challengeChainId }),
        context: {},
      }),
    )

    expect(requestedChainId).toBe(challengeChainId)
    expect(credential.source).toBe(`did:pkh:eip155:${challengeChainId}:${account.address}`)
  })

  test('behavior: context account overrides default account', async () => {
    const client = createClient({
      account,
      chain,
      transport: http(),
    })
    const method = charge({
      account,
      getClient: () => client,
    })

    const credential = Credential.deserialize(
      await method.createCredential({
        challenge: createChallenge({ chainId }),
        context: { account: otherAccount },
      }),
    )

    expect(credential.source).toBe(`did:pkh:eip155:${chainId}:${otherAccount.address}`)
  })
})
