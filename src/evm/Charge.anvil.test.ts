import { Credential, Receipt } from 'mppx'
import { Mppx as Mppx_client, evm as evm_client } from 'mppx/client'
import { Mppx, evm } from 'mppx/server'
import { erc20Abi, type Address } from 'viem'
import { readContract, waitForTransactionReceipt, writeContract } from 'viem/actions'
import { afterAll, beforeAll, describe, expect, test } from 'vp/test'
import { startAnvil, type AnvilFixture } from '~test/evm/anvil.js'

const realm = 'api.example.com'
const secretKey = 'test-secret-key'

let fixture: AnvilFixture

beforeAll(async () => {
  fixture = await startAnvil()
})

afterAll(async () => {
  await fixture?.stop()
})

describe('evm charge on Anvil', () => {
  test('settles a standard ERC-20 transfer transaction', async () => {
    const before = await balanceOf(fixture.token, fixture.recipient.address)
    const server = Mppx.create({
      methods: [
        evm({
          amount: '1',
          chainId: fixture.chain.id,
          credentialTypes: ['transaction'],
          currency: fixture.token,
          decimals: 6,
          getClient: () => fixture.serverClient,
          recipient: fixture.recipient.address,
        }),
      ],
      realm,
      secretKey,
    })
    const client = Mppx_client.create({
      methods: [
        evm_client({
          account: fixture.payer,
          credentialType: 'transaction',
          getClient: () => fixture.payerClient,
        }),
      ],
      polyfill: false,
    })

    const { receipt } = await settle({ client, server })

    expect(receipt).toMatchObject({
      chainId: fixture.chain.id,
      method: 'evm',
      status: 'success',
    })
    expect(receipt.reference).toMatch(/^0x[0-9a-f]{64}$/i)
    await expect(balanceOf(fixture.token, fixture.recipient.address)).resolves.toBe(
      before + 1_000_000n,
    )
  })

  test('verifies a client-broadcast ERC-20 transfer hash and rejects replay', async () => {
    const before = await balanceOf(fixture.token, fixture.recipient.address)
    const server = Mppx.create({
      methods: [
        evm({
          amount: '1',
          chainId: fixture.chain.id,
          credentialTypes: ['hash'],
          currency: fixture.token,
          decimals: 6,
          getClient: () => fixture.serverClient,
          recipient: fixture.recipient.address,
        }),
      ],
      realm,
      secretKey,
    })
    const client = Mppx_client.create({
      methods: [
        evm_client({
          account: fixture.payer,
          credentialType: 'hash',
          getClient: () => fixture.payerClient,
        }),
      ],
      polyfill: false,
    })

    const { authorization, receipt } = await settle({ client, server })

    expect(receipt.reference).toMatch(/^0x[0-9a-f]{64}$/i)
    await expect(balanceOf(fixture.token, fixture.recipient.address)).resolves.toBe(
      before + 1_000_000n,
    )

    const replay = await server.charge({ expires: expires() })(
      new Request('https://api.example.com/resource', {
        headers: { Authorization: authorization },
      }),
    )

    expect(replay.status).toBe(402)
    if (replay.status !== 402) throw new Error('Expected replay to be rejected.')
    await expect(replay.challenge.json()).resolves.toMatchObject({
      status: 402,
      title: 'Verification Failed',
    })
  })

  test('allows hash credential retry after the transaction is mined', async () => {
    const before = await balanceOf(fixture.token, fixture.recipient.address)
    const server = Mppx.create({
      methods: [
        evm({
          amount: '1',
          chainId: fixture.chain.id,
          credentialTypes: ['hash'],
          currency: fixture.token,
          decimals: 6,
          getClient: () => fixture.serverClient,
          recipient: fixture.recipient.address,
        }),
      ],
      realm,
      secretKey,
    })
    const client = Mppx_client.create({
      methods: [
        evm_client({
          account: fixture.payer,
          credentialType: 'hash',
          getClient: () => fixture.payerClient,
        }),
      ],
      polyfill: false,
    })

    await anvilRequest('evm_setAutomine', [false])
    try {
      const challenge = await server.charge({ expires: expires() })(
        new Request('https://api.example.com/resource'),
      )
      expect(challenge.status).toBe(402)
      if (challenge.status !== 402) throw new Error('Expected an EVM charge challenge.')

      const authorization = await client.createCredential(challenge.challenge)
      const pending = await server.charge({ expires: expires() })(
        new Request('https://api.example.com/resource', {
          headers: { Authorization: authorization },
        }),
      )
      expect(pending.status).toBe(402)

      await anvilRequest('evm_mine', [])

      const settled = await server.charge({ expires: expires() })(
        new Request('https://api.example.com/resource', {
          headers: { Authorization: authorization },
        }),
      )
      expect(settled.status).toBe(200)
      if (settled.status !== 200) throw new Error('Expected retry to settle.')
      const receipt = Receipt.fromResponse(settled.withReceipt(new Response('ok')))
      expect(receipt.reference).toMatch(/^0x[0-9a-f]{64}$/i)
      await expect(balanceOf(fixture.token, fixture.recipient.address)).resolves.toBe(
        before + 1_000_000n,
      )

      const replay = await server.charge({ expires: expires() })(
        new Request('https://api.example.com/resource', {
          headers: { Authorization: authorization },
        }),
      )
      expect(replay.status).toBe(402)
    } finally {
      await anvilRequest('evm_setAutomine', [true])
      await anvilRequest('evm_mine', [])
    }
  })

  test('creates fresh Permit2 default nonces and preserves nonce overrides', async () => {
    const server = createPermit2Server()
    const client = createPermit2Client()
    const challenge = await server.charge({ expires: expires() })(
      new Request('https://api.example.com/resource'),
    )
    expect(challenge.status).toBe(402)
    if (challenge.status !== 402) throw new Error('Expected an EVM charge challenge.')

    const first = permit2Payload(await client.createCredential(challenge.challenge))
    const second = permit2Payload(await client.createCredential(challenge.challenge))

    expect(first.permit.nonce).toMatch(/^[1-9]\d*$/)
    expect(second.permit.nonce).toMatch(/^[1-9]\d*$/)
    expect(second.permit.nonce).not.toBe(first.permit.nonce)

    const explicit = createPermit2Client({ permit2: { nonce: 123n } })
    expect(permit2Payload(await explicit.createCredential(challenge.challenge)).permit.nonce).toBe(
      '123',
    )
  })

  test('settles a Permit2 credential using ERC-20 approval and rejects replay', async () => {
    const before = await balanceOf(fixture.token, fixture.recipient.address)
    const server = createPermit2Server()
    const client = createPermit2Client()
    await approvePermit2(2_000_000n)

    const { authorization, receipt } = await settle({ client, server })

    expect(receipt.reference).toMatch(/^0x[0-9a-f]{64}$/i)
    await expect(balanceOf(fixture.token, fixture.recipient.address)).resolves.toBe(
      before + 1_000_000n,
    )

    const replay = await server.charge({ expires: expires() })(
      new Request('https://api.example.com/resource', {
        headers: { Authorization: authorization },
      }),
    )
    expect(replay.status).toBe(402)
  })

  test('does not consume a Permit2 credential when ERC-20 approval is insufficient', async () => {
    const before = await balanceOf(fixture.token, fixture.recipient.address)
    const server = createPermit2Server()
    const client = createPermit2Client()
    await approvePermit2(0n)

    const challenge = await server.charge({ expires: expires() })(
      new Request('https://api.example.com/resource'),
    )
    expect(challenge.status).toBe(402)
    if (challenge.status !== 402) throw new Error('Expected an EVM charge challenge.')

    const authorization = await client.createCredential(challenge.challenge)
    const rejected = await server.charge({ expires: expires() })(
      new Request('https://api.example.com/resource', {
        headers: { Authorization: authorization },
      }),
    )
    expect(rejected.status).toBe(402)

    await approvePermit2(1_000_000n)
    const settled = await server.charge({ expires: expires() })(
      new Request('https://api.example.com/resource', {
        headers: { Authorization: authorization },
      }),
    )
    expect(settled.status).toBe(200)
    if (settled.status !== 200) throw new Error('Expected retry to settle.')
    await expect(balanceOf(fixture.token, fixture.recipient.address)).resolves.toBe(
      before + 1_000_000n,
    )
  })

  test('settles an EIP-3009 transferWithAuthorization credential and rejects replay', async () => {
    const before = await balanceOf(fixture.authorizationToken, fixture.recipient.address)
    const authorizationDomain = {
      chainId: fixture.chain.id,
      name: 'Mock EIP3009 USDC',
      verifyingContract: fixture.authorizationToken,
      version: '1',
    } as const
    const server = Mppx.create({
      methods: [
        evm({
          account: fixture.deployer,
          amount: '1',
          authorizationDomain,
          chainId: fixture.chain.id,
          credentialTypes: ['authorization'],
          currency: fixture.authorizationToken,
          decimals: 6,
          getClient: () => fixture.serverClient,
          recipient: fixture.recipient.address,
        }),
      ],
      realm,
      secretKey,
    })
    const client = Mppx_client.create({
      methods: [
        evm_client({
          account: fixture.payer,
          authorizationDomain,
          credentialType: 'authorization',
          getClient: () => fixture.payerClient,
        }),
      ],
      polyfill: false,
    })

    const { authorization, receipt } = await settle({ client, server })

    expect(receipt.reference).toMatch(/^0x[0-9a-f]{64}$/i)
    await expect(balanceOf(fixture.authorizationToken, fixture.recipient.address)).resolves.toBe(
      before + 1_000_000n,
    )

    const replay = await server.charge({ expires: expires() })(
      new Request('https://api.example.com/resource', {
        headers: { Authorization: authorization },
      }),
    )

    expect(replay.status).toBe(402)
    if (replay.status !== 402) throw new Error('Expected replay to be rejected.')
    await expect(replay.challenge.json()).resolves.toMatchObject({
      status: 402,
      title: 'Verification Failed',
    })
  })
})

async function settle(parameters: { client: any; server: any }): Promise<{
  authorization: string
  receipt: Receipt.Receipt
}> {
  const challenge = await parameters.server.charge({ expires: expires() })(
    new Request('https://api.example.com/resource'),
  )
  expect(challenge.status).toBe(402)
  if (challenge.status !== 402) throw new Error('Expected an EVM charge challenge.')

  const authorization = await parameters.client.createCredential(challenge.challenge)
  const result = await parameters.server.charge({ expires: expires() })(
    new Request('https://api.example.com/resource', {
      headers: { Authorization: authorization },
    }),
  )

  expect(result.status).toBe(200)
  if (result.status !== 200) throw new Error('Expected EVM charge settlement.')

  const response = result.withReceipt(new Response('ok'))
  const receipt = Receipt.fromResponse(response)
  expect(receipt.challengeId).toBeDefined()

  return { authorization, receipt }
}

function expires() {
  return new Date(Date.now() + 60_000).toISOString()
}

function balanceOf(token: Address, owner: Address) {
  return readContract(fixture.publicClient, {
    abi: erc20Abi,
    address: token,
    args: [owner],
    functionName: 'balanceOf',
  })
}

function createPermit2Server() {
  return Mppx.create({
    methods: [
      evm({
        account: fixture.deployer,
        amount: '1',
        chainId: fixture.chain.id,
        credentialTypes: ['permit2'],
        currency: fixture.token,
        decimals: 6,
        getClient: () => fixture.serverClient,
        permit2Address: fixture.permit2,
        recipient: fixture.recipient.address,
        spender: fixture.deployer.address,
      }),
    ],
    realm,
    secretKey,
  })
}

function createPermit2Client(options: { permit2?: { nonce: bigint } } = {}) {
  return Mppx_client.create({
    methods: [
      evm_client({
        account: fixture.payer,
        credentialType: 'permit2',
        getClient: () => fixture.payerClient,
        permit2: options.permit2,
      }),
    ],
    polyfill: false,
  })
}

function permit2Payload(authorization: string) {
  const credential = Credential.deserialize<any>(authorization)
  expect(credential.payload.type).toBe('permit2')
  return credential.payload as {
    permit: { nonce: string }
    type: 'permit2'
  }
}

async function approvePermit2(amount: bigint) {
  const hash = await writeContract(fixture.payerClient, {
    abi: erc20Abi,
    account: fixture.payer,
    address: fixture.token,
    args: [fixture.permit2, amount],
    chain: fixture.chain,
    functionName: 'approve',
  })
  await waitForTransactionReceipt(fixture.publicClient, { hash })
}

function anvilRequest(method: string, params: readonly unknown[]) {
  return fixture.publicClient.request({ method, params } as never)
}
