import { Challenge, Credential, type z } from 'mppx'
import { Mppx as Mppx_client, tempo as tempo_client } from 'mppx/client'
import { Mppx as Mppx_server, tempo as tempo_server } from 'mppx/server'
import type { Address } from 'viem'
import { describe, expect, test } from 'vp/test'
import { nodeEnv } from '~test/config.js'
import * as Http from '~test/Http.js'
import { accounts, asset, chain, client, fundAccount } from '~test/tempo/viem.js'

import * as Store from '../../../Store.js'
import * as AuthorizeStore from '../../authorize/Store.js'
import * as Methods from '../../Methods.js'
import { getChannelState } from '../Chain.js'
import { tip20ChannelEscrow } from '../Constants.js'

const isPrecompileTestnet = nodeEnv === 'localnet' || nodeEnv === 'devnet'
const keyPrefix = 'integration:tempo:authorize:'
const payer = accounts[2]
const payee = accounts[0]
const realm = 'api.example.com'
const secretKey = 'test-secret-key'

type AuthorizeRequestInput = z.input<typeof Methods.authorize.schema.request>
type BindingCase = {
  label: string
  credentialRequest: Partial<AuthorizeRequestInput>
  submitRequest?: Partial<AuthorizeRequestInput> | undefined
  mutateCredential?: ((credential: Credential.Credential) => Credential.Credential) | undefined
}

function createServerMethod(
  rawStore: Store.AtomicStore,
  options: Partial<Parameters<typeof tempo_server.authorize>[0]> = {},
) {
  return tempo_server.authorize({
    account: payee,
    amount: '1000',
    chainId: chain.id,
    currency: asset,
    decimals: 0,
    getClient: () => client,
    keyPrefix,
    store: rawStore,
    ...options,
  })
}

function createClientMppx() {
  return Mppx_client.create({
    polyfill: false,
    methods: [
      tempo_client.authorize({
        account: payer,
        getClient: () => client,
      }),
    ],
  })
}

function authorizeRequest(overrides: Partial<AuthorizeRequestInput> = {}) {
  return {
    amount: '1000',
    authorizedSigner: payee.address,
    chainId: chain.id,
    currency: asset,
    decimals: 0,
    escrowContract: tip20ChannelEscrow,
    operator: payee.address,
    recipient: payee.address,
    ...overrides,
  } satisfies AuthorizeRequestInput
}

async function createCredentialFor(request: AuthorizeRequestInput): Promise<Credential.Credential> {
  const challenge = Challenge.fromMethod(Methods.authorize, {
    expires: new Date(Date.now() + 60_000).toISOString(),
    realm,
    request,
    secretKey,
  })
  const method = createClientMppx().methods[0]!
  return Credential.deserialize(
    await method.createCredential({ challenge: challenge as never, context: {} }),
  )
}

async function registerAuthorization(options: { amount?: string; captureKeyPrefix?: string } = {}) {
  await fundAccount({ address: payer.address, token: asset })

  const rawStore = Store.memory()
  const authorizationStore = AuthorizeStore.fromStore(rawStore, { keyPrefix })
  const serverMppx = Mppx_server.create({
    methods: [createServerMethod(rawStore, { amount: options.amount ?? '1000' })],
    realm,
    secretKey,
  })
  const clientMppx = createClientMppx()

  const httpServer = await Http.createServer(async (req, res) => {
    const result = await Mppx_server.toNodeListener(serverMppx.authorize(authorizeRequest()))(
      req,
      res,
    )
    if (result.status === 402) return
    res.end('unexpected protected handler')
  })

  try {
    const challengeResponse = await fetch(httpServer.url)
    expect(challengeResponse.status).toBe(402)

    const credential = await clientMppx.createCredential(challengeResponse)
    const authorizationResponse = await fetch(httpServer.url, {
      headers: { Authorization: credential },
    })
    expect(authorizationResponse.status).toBe(200)
    expect(authorizationResponse.headers.get('Payment-Receipt')).toBeNull()

    const body = (await authorizationResponse.json()) as {
      authorization: { id: `0x${string}`; amount: string; capturedAmount: string }
    }
    return { authorizationStore, body, rawStore }
  } finally {
    httpServer.close()
  }
}

describe.runIf(isPrecompileTestnet)('precompile server authorize integration', () => {
  test('registers and captures a real authorize channel over HTTP', async () => {
    const { authorizationStore, body, rawStore } = await registerAuthorization()
    expect(body.authorization.amount).toBe('1000')
    expect(body.authorization.capturedAmount).toBe('0')

    const authorization = await authorizationStore.get(body.authorization.id)
    expect(authorization?.amount).toBe('1000')
    expect(authorization?.channel.id).toBe(body.authorization.id)

    const receipt = await tempo_server.capture(rawStore, client, body.authorization.id, {
      account: payee,
      amount: '250',
      keyPrefix,
    })
    expect(receipt.authorizationId).toBe(body.authorization.id)
    expect(receipt.capturedAmount).toBe('250')
    expect(receipt.delta).toBe('250')

    const state = await getChannelState(client, body.authorization.id, tip20ChannelEscrow)
    expect(state.deposit).toBe(1000n)
    expect(state.settled).toBe(250n)
  })

  const bindingCases: BindingCase[] = [
    {
      label: 'channelId',
      credentialRequest: {},
      submitRequest: {},
      mutateCredential(credential: Credential.Credential) {
        return Credential.from({
          challenge: credential.challenge,
          payload: {
            ...(credential.payload as Record<string, unknown>),
            channelId: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          },
        })
      },
    },
    {
      label: 'amount',
      credentialRequest: { amount: '999' },
      submitRequest: {},
    },
    {
      label: 'recipient',
      credentialRequest: { recipient: accounts[3].address as Address },
      submitRequest: {},
    },
    {
      label: 'operator',
      credentialRequest: { operator: accounts[3].address as Address },
      submitRequest: {},
    },
    {
      label: 'authorizedSigner',
      credentialRequest: { authorizedSigner: accounts[3].address as Address },
      submitRequest: {},
    },
  ]

  test.each(bindingCases)(
    'rejects tampered authorize credential binding: $label',
    async (entry) => {
      await fundAccount({ address: payer.address, token: asset })

      const rawStore = Store.memory()
      const method = createServerMethod(rawStore)
      const credential = await createCredentialFor(authorizeRequest(entry.credentialRequest))
      const submittedCredential = entry.mutateCredential?.(credential) ?? credential

      await expect(
        method.verify({
          credential: submittedCredential as never,
          request: authorizeRequest(entry.submitRequest ?? {}),
        }),
      ).rejects.toThrow()
    },
  )

  test('rejects replayed authorize credentials', async () => {
    await fundAccount({ address: payer.address, token: asset })

    const rawStore = Store.memory()
    const serverMppx = Mppx_server.create({
      methods: [createServerMethod(rawStore)],
      realm,
      secretKey,
    })
    const clientMppx = createClientMppx()
    const httpServer = await Http.createServer(async (req, res) => {
      const result = await Mppx_server.toNodeListener(serverMppx.authorize(authorizeRequest()))(
        req,
        res,
      )
      if (result.status === 402) return
      res.end('unexpected protected handler')
    })

    try {
      const challengeResponse = await fetch(httpServer.url)
      const credential = await clientMppx.createCredential(challengeResponse)
      expect((await fetch(httpServer.url, { headers: { Authorization: credential } })).status).toBe(
        200,
      )

      const replay = await fetch(httpServer.url, { headers: { Authorization: credential } })
      expect(replay.status).toBe(402)
      expect(((await replay.json()) as { detail: string }).detail).toContain('already been used')
    } finally {
      httpServer.close()
    }
  })

  test('rejects over-capture', async () => {
    const { body, rawStore } = await registerAuthorization()

    await expect(
      tempo_server.capture(rawStore, client, body.authorization.id, {
        account: payee,
        amount: '1001',
        keyPrefix,
      }),
    ).rejects.toThrow('capture exceeds authorized amount')
  })

  test('returns the same receipt for repeated capture idempotency keys', async () => {
    const { body, rawStore } = await registerAuthorization()

    const first = await tempo_server.capture(rawStore, client, body.authorization.id, {
      account: payee,
      amount: '250',
      idempotencyKey: 'capture-1',
      keyPrefix,
    })
    const second = await tempo_server.capture(rawStore, client, body.authorization.id, {
      account: payee,
      amount: '250',
      idempotencyKey: 'capture-1',
      keyPrefix,
    })

    expect(second).toEqual(first)
  })

  test('captures partially, closes with remaining amount, then rejects later capture', async () => {
    const { body, rawStore } = await registerAuthorization()

    await tempo_server.capture(rawStore, client, body.authorization.id, {
      account: payee,
      amount: '250',
      keyPrefix,
    })
    const closed = await tempo_server.capture(rawStore, client, body.authorization.id, {
      account: payee,
      amount: '750',
      close: true,
      keyPrefix,
    })
    expect(closed.capturedAmount).toBe('1000')

    await expect(
      tempo_server.capture(rawStore, client, body.authorization.id, {
        account: payee,
        amount: '1',
        keyPrefix,
      }),
    ).rejects.toThrow('authorization is closed')
  })

  test('voids an authorization and rejects subsequent capture', async () => {
    const { authorizationStore, body, rawStore } = await registerAuthorization()

    const receipt = await tempo_server.voidAuthorization(rawStore, client, body.authorization.id, {
      account: payee,
      keyPrefix,
    })
    expect(receipt.status).toBe('voided')
    expect((await authorizationStore.get(body.authorization.id))?.status).toBe('voided')

    await expect(
      tempo_server.capture(rawStore, client, body.authorization.id, {
        account: payee,
        amount: '1',
        keyPrefix,
      }),
    ).rejects.toThrow('authorization is voided')
  })
})
