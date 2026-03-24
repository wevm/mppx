import { Challenge, Credential, Receipt } from 'mppx'
import { Mppx as Mppx_client, tempo as tempo_client } from 'mppx/client'
import { Mppx as Mppx_server, tempo as tempo_server } from 'mppx/server'
import { Base64 } from 'ox'
import type { Hex } from 'ox'
import { TxEnvelopeTempo } from 'ox/tempo'
import { Handler } from 'tempo.ts/server'
import { createClient, custom, encodeFunctionData, parseUnits } from 'viem'
import { getTransactionReceipt, prepareTransactionRequest, signTransaction } from 'viem/actions'
import { Abis, Account, Actions, Addresses, Secp256k1, Tick, Transaction } from 'viem/tempo'
import { beforeAll, describe, expect, test } from 'vitest'
import * as Http from '~test/Http.js'
import { closeChannelOnChain, deployEscrow, openChannel } from '~test/tempo/session.js'
import { accounts, asset, chain, client, fundAccount } from '~test/tempo/viem.js'

import * as Store from '../../Store.js'
import * as Attribution from '../Attribution.js'
import { signVoucher } from '../session/Voucher.js'

const realm = 'api.example.com'
const secretKey = 'test-secret-key'

const server = Mppx_server.create({
  methods: [
    tempo_server.charge({
      getClient() {
        return client
      },
      currency: asset,
      account: accounts[0],
    }),
  ],
  realm,
  secretKey,
})

describe('tempo', () => {
  describe('intent: charge; type: hash', () => {
    test('default', async () => {
      const mppx = Mppx_client.create({
        polyfill: false,
        methods: [
          tempo_client({
            account: accounts[1],
            mode: 'push',
            getClient: () => client,
          }),
        ],
      })

      const httpServer = await Http.createServer(async (req, res) => {
        const result = await Mppx_server.toNodeListener(
          server.charge({ amount: '1', decimals: 6 }),
        )(req, res)
        if (result.status === 402) return
        res.end('OK')
      })

      const response = await mppx.fetch(httpServer.url)
      expect(response.status).toBe(200)

      const receipt = Receipt.fromResponse(response)
      expect({
        ...receipt,
        reference: '[reference]',
        timestamp: '[timestamp]',
      }).toMatchInlineSnapshot(`
            {
              "method": "tempo",
              "reference": "[reference]",
              "status": "success",
              "timestamp": "[timestamp]",
            }
          `)

      httpServer.close()
    })

    test('behavior: overrides', async () => {
      const overrideRecipient = accounts[2].address
      const overrideCurrency = asset
      const overrideExpires = new Date(Date.now() + 60_000).toISOString()

      const mppx = Mppx_client.create({
        polyfill: false,
        methods: [
          tempo_client({
            account: accounts[1],
            mode: 'push',
            getClient: () => client,
          }),
        ],
      })

      const httpServer = await Http.createServer(async (req, res) => {
        const result = await Mppx_server.toNodeListener(
          server.charge({
            amount: '1',
            currency: overrideCurrency,
            expires: overrideExpires,
            recipient: overrideRecipient,
          }),
        )(req, res)
        if (result.status === 402) return
        res.end('OK')
      })

      const response = await mppx.fetch(httpServer.url)
      expect(response.status).toBe(200)

      const receipt = Receipt.fromResponse(response)
      expect(receipt.status).toBe('success')

      httpServer.close()
    })

    test('behavior: rejects replayed transaction hash', async () => {
      const dedupServer = Mppx_server.create({
        methods: [
          tempo_server.charge({
            getClient() {
              return client
            },
            currency: asset,
            account: accounts[0],
            store: Store.memory(),
          }),
        ],
        realm,
        secretKey,
      })

      const httpServer = await Http.createServer(async (req, res) => {
        const result = await Mppx_server.toNodeListener(dedupServer.charge({ amount: '1' }))(
          req,
          res,
        )
        if (result.status === 402) return
        res.end('OK')
      })

      const response1 = await fetch(httpServer.url)
      expect(response1.status).toBe(402)

      const challenge1 = Challenge.fromResponse(response1, {
        methods: [tempo_client.charge()],
      })

      const { receipt } = await Actions.token.transferSync(client, {
        account: accounts[1],
        amount: BigInt(challenge1.request.amount),
        memo: Base64.toHex(challenge1.id) as Hex.Hex,
        to: challenge1.request.recipient as Hex.Hex,
        token: challenge1.request.currency as Hex.Hex,
      })

      const credential1 = Credential.from({
        challenge: challenge1,
        payload: { hash: receipt.transactionHash, type: 'hash' as const },
      })

      {
        const response = await fetch(httpServer.url, {
          headers: { Authorization: Credential.serialize(credential1) },
        })
        expect(response.status).toBe(200)
      }

      const response2 = await fetch(httpServer.url)
      expect(response2.status).toBe(402)

      const challenge2 = Challenge.fromResponse(response2, {
        methods: [tempo_client.charge()],
      })

      const mixedCaseHash = `0x${receipt.transactionHash.slice(2).toUpperCase()}` as Hex.Hex

      const credential2 = Credential.from({
        challenge: challenge2,
        payload: { hash: mixedCaseHash, type: 'hash' as const },
      })

      {
        const response = await fetch(httpServer.url, {
          headers: { Authorization: Credential.serialize(credential2) },
        })
        expect(response.status).toBe(402)
        const body = (await response.json()) as { detail: string }
        expect(body.detail).toContain('Transaction hash has already been used')
      }

      httpServer.close()
    })

    test('behavior: rejects replayed hash with alternating case', async () => {
      const dedupServer = Mppx_server.create({
        methods: [
          tempo_server.charge({
            getClient() {
              return client
            },
            currency: asset,
            account: accounts[0],
            store: Store.memory(),
          }),
        ],
        realm,
        secretKey,
      })

      const httpServer = await Http.createServer(async (req, res) => {
        const result = await Mppx_server.toNodeListener(dedupServer.charge({ amount: '1' }))(
          req,
          res,
        )
        if (result.status === 402) return
        res.end('OK')
      })

      const response1 = await fetch(httpServer.url)
      expect(response1.status).toBe(402)

      const challenge1 = Challenge.fromResponse(response1, {
        methods: [tempo_client.charge()],
      })

      const { receipt } = await Actions.token.transferSync(client, {
        account: accounts[1],
        amount: BigInt(challenge1.request.amount),
        memo: Base64.toHex(challenge1.id) as Hex.Hex,
        to: challenge1.request.recipient as Hex.Hex,
        token: challenge1.request.currency as Hex.Hex,
      })

      // Submit original hash with alternating case (aB, not all upper or lower)
      const hex = receipt.transactionHash.slice(2)
      const alternating = `0x${hex
        .split('')
        .map((c, i) => (i % 2 === 0 ? c.toUpperCase() : c.toLowerCase()))
        .join('')}` as Hex.Hex

      const credential1 = Credential.from({
        challenge: challenge1,
        payload: { hash: alternating, type: 'hash' as const },
      })

      {
        const response = await fetch(httpServer.url, {
          headers: { Authorization: Credential.serialize(credential1) },
        })
        expect(response.status).toBe(200)
      }

      // Replay with lowercase — should be rejected
      const response2 = await fetch(httpServer.url)
      expect(response2.status).toBe(402)

      const challenge2 = Challenge.fromResponse(response2, {
        methods: [tempo_client.charge()],
      })

      const credential2 = Credential.from({
        challenge: challenge2,
        payload: { hash: receipt.transactionHash.toLowerCase() as Hex.Hex, type: 'hash' as const },
      })

      {
        const response = await fetch(httpServer.url, {
          headers: { Authorization: Credential.serialize(credential2) },
        })
        expect(response.status).toBe(402)
        const body = (await response.json()) as { detail: string }
        expect(body.detail).toContain('Transaction hash has already been used')
      }

      httpServer.close()
    })

    test('behavior: accepts uppercase hash on first use', async () => {
      const dedupServer = Mppx_server.create({
        methods: [
          tempo_server.charge({
            getClient() {
              return client
            },
            currency: asset,
            account: accounts[0],
            store: Store.memory(),
          }),
        ],
        realm,
        secretKey,
      })

      const httpServer = await Http.createServer(async (req, res) => {
        const result = await Mppx_server.toNodeListener(dedupServer.charge({ amount: '1' }))(
          req,
          res,
        )
        if (result.status === 402) return
        res.end('OK')
      })

      const response1 = await fetch(httpServer.url)
      expect(response1.status).toBe(402)

      const challenge1 = Challenge.fromResponse(response1, {
        methods: [tempo_client.charge()],
      })

      const { receipt } = await Actions.token.transferSync(client, {
        account: accounts[1],
        amount: BigInt(challenge1.request.amount),
        memo: Base64.toHex(challenge1.id) as Hex.Hex,
        to: challenge1.request.recipient as Hex.Hex,
        token: challenge1.request.currency as Hex.Hex,
      })

      const upperHash = `0x${receipt.transactionHash.slice(2).toUpperCase()}` as Hex.Hex

      const credential1 = Credential.from({
        challenge: challenge1,
        payload: { hash: upperHash, type: 'hash' as const },
      })

      {
        const response = await fetch(httpServer.url, {
          headers: { Authorization: Credential.serialize(credential1) },
        })
        expect(response.status).toBe(200)
      }

      httpServer.close()
    })

    test('behavior: rejects hash with non-matching Transfer log', async () => {
      const wrongRecipient = accounts[2].address

      const httpServer = await Http.createServer(async (req, res) => {
        const result = await Mppx_server.toNodeListener(server.charge({ amount: '1' }))(req, res)
        if (result.status === 402) return
        res.end('OK')
      })

      const response = await fetch(httpServer.url)
      expect(response.status).toBe(402)

      const challenge = Challenge.fromResponse(response, {
        methods: [tempo_client.charge()],
      })
      const request = challenge.request

      const { receipt } = await Actions.token.transferSync(client, {
        account: accounts[1],
        amount: BigInt(request.amount),
        memo: Base64.toHex(challenge.id) as Hex.Hex,
        to: wrongRecipient,
        token: request.currency as Hex.Hex,
      })

      const credential = Credential.from({
        challenge,
        payload: { hash: receipt.transactionHash, type: 'hash' as const },
      })

      {
        const response = await fetch(httpServer.url, {
          headers: { Authorization: Credential.serialize(credential) },
        })
        expect(response.status).toBe(402)
        const body = (await response.json()) as { detail: string }
        expect(body.detail).toContain('no matching transfer with memo found')
      }

      httpServer.close()
    })

    test('behavior: rejects session settlement tx hash used as charge credential', async () => {
      const chargeAmount = parseUnits('1', 6)
      const recipient = accounts[0].address
      const external = accounts[3]

      const escrow = await deployEscrow()

      await fundAccount({ address: external.address, token: Addresses.pathUsd })
      await fundAccount({ address: external.address, token: asset })

      const salt = '0x0000000000000000000000000000000000000000000000000000000000000001' as Hex.Hex
      const { channelId } = await openChannel({
        escrow,
        payer: external,
        payee: recipient,
        token: asset,
        deposit: chargeAmount,
        salt,
      })

      const voucherSig = await signVoucher(
        client,
        external,
        { channelId, cumulativeAmount: chargeAmount },
        escrow,
        chain.id,
      )

      const { txHash: settleTxHash } = await closeChannelOnChain({
        escrow,
        payee: accounts[0],
        channelId,
        cumulativeAmount: chargeAmount,
        signature: voucherSig,
      })

      const httpServer = await Http.createServer(async (req, res) => {
        const result = await Mppx_server.toNodeListener(server.charge({ amount: '1' }))(req, res)
        if (result.status === 402) return
        res.end('OK')
      })

      const response = await fetch(httpServer.url)
      expect(response.status).toBe(402)

      const challenge = Challenge.fromResponse(response, {
        methods: [tempo_client.charge()],
      })

      const credential = Credential.from({
        challenge,
        payload: { hash: settleTxHash, type: 'hash' as const },
      })

      {
        const response = await fetch(httpServer.url, {
          headers: { Authorization: Credential.serialize(credential) },
        })
        expect(response.status).toBe(402)
        const body = (await response.json()) as { detail: string }
        expect(body.detail).toContain('no matching transfer with memo found')
      }

      httpServer.close()
    })

    test('behavior: rejects replayed transaction hash', async () => {
      const dedupServer = Mppx_server.create({
        methods: [
          tempo_server.charge({
            getClient() {
              return client
            },
            currency: asset,
            account: accounts[0],
            store: Store.memory(),
          }),
        ],
        realm,
        secretKey,
      })

      const httpServer = await Http.createServer(async (req, res) => {
        const result = await Mppx_server.toNodeListener(dedupServer.charge({ amount: '1' }))(
          req,
          res,
        )
        if (result.status === 402) return
        res.end('OK')
      })

      const response1 = await fetch(httpServer.url)
      expect(response1.status).toBe(402)

      const challenge1 = Challenge.fromResponse(response1, {
        methods: [tempo_client.charge()],
      })

      const { receipt } = await Actions.token.transferSync(client, {
        account: accounts[1],
        amount: BigInt(challenge1.request.amount),
        memo: Base64.toHex(challenge1.id) as Hex.Hex,
        to: challenge1.request.recipient as Hex.Hex,
        token: challenge1.request.currency as Hex.Hex,
      })

      const credential1 = Credential.from({
        challenge: challenge1,
        payload: { hash: receipt.transactionHash, type: 'hash' as const },
      })

      {
        const response = await fetch(httpServer.url, {
          headers: { Authorization: Credential.serialize(credential1) },
        })
        expect(response.status).toBe(200)
      }

      const response2 = await fetch(httpServer.url)
      expect(response2.status).toBe(402)

      const challenge2 = Challenge.fromResponse(response2, {
        methods: [tempo_client.charge()],
      })

      const mixedCaseHash = `0x${receipt.transactionHash.slice(2).toUpperCase()}` as Hex.Hex

      const credential2 = Credential.from({
        challenge: challenge2,
        payload: { hash: mixedCaseHash, type: 'hash' as const },
      })

      {
        const response = await fetch(httpServer.url, {
          headers: { Authorization: Credential.serialize(credential2) },
        })
        expect(response.status).toBe(402)
        const body = (await response.json()) as { detail: string }
        expect(body.detail).toContain('Transaction hash has already been used')
      }

      httpServer.close()
    })

    test('behavior: rejects replayed hash with alternating case', async () => {
      const dedupServer = Mppx_server.create({
        methods: [
          tempo_server.charge({
            getClient() {
              return client
            },
            currency: asset,
            account: accounts[0],
            store: Store.memory(),
          }),
        ],
        realm,
        secretKey,
      })

      const httpServer = await Http.createServer(async (req, res) => {
        const result = await Mppx_server.toNodeListener(dedupServer.charge({ amount: '1' }))(
          req,
          res,
        )
        if (result.status === 402) return
        res.end('OK')
      })

      const response1 = await fetch(httpServer.url)
      expect(response1.status).toBe(402)

      const challenge1 = Challenge.fromResponse(response1, {
        methods: [tempo_client.charge()],
      })

      const { receipt } = await Actions.token.transferSync(client, {
        account: accounts[1],
        amount: BigInt(challenge1.request.amount),
        memo: Base64.toHex(challenge1.id) as Hex.Hex,
        to: challenge1.request.recipient as Hex.Hex,
        token: challenge1.request.currency as Hex.Hex,
      })

      const hex = receipt.transactionHash.slice(2)
      const alternating = `0x${hex
        .split('')
        .map((c, i) => (i % 2 === 0 ? c.toUpperCase() : c.toLowerCase()))
        .join('')}` as Hex.Hex

      const credential1 = Credential.from({
        challenge: challenge1,
        payload: { hash: alternating, type: 'hash' as const },
      })

      {
        const response = await fetch(httpServer.url, {
          headers: { Authorization: Credential.serialize(credential1) },
        })
        expect(response.status).toBe(200)
      }

      const response2 = await fetch(httpServer.url)
      expect(response2.status).toBe(402)

      const challenge2 = Challenge.fromResponse(response2, {
        methods: [tempo_client.charge()],
      })

      const credential2 = Credential.from({
        challenge: challenge2,
        payload: { hash: receipt.transactionHash.toLowerCase() as Hex.Hex, type: 'hash' as const },
      })

      {
        const response = await fetch(httpServer.url, {
          headers: { Authorization: Credential.serialize(credential2) },
        })
        expect(response.status).toBe(402)
        const body = (await response.json()) as { detail: string }
        expect(body.detail).toContain('Transaction hash has already been used')
      }

      httpServer.close()
    })

    test('behavior: accepts uppercase hash on first use', async () => {
      const dedupServer = Mppx_server.create({
        methods: [
          tempo_server.charge({
            getClient() {
              return client
            },
            currency: asset,
            account: accounts[0],
            store: Store.memory(),
          }),
        ],
        realm,
        secretKey,
      })

      const httpServer = await Http.createServer(async (req, res) => {
        const result = await Mppx_server.toNodeListener(dedupServer.charge({ amount: '1' }))(
          req,
          res,
        )
        if (result.status === 402) return
        res.end('OK')
      })

      const response = await fetch(httpServer.url)
      expect(response.status).toBe(402)

      const challenge = Challenge.fromResponse(response, {
        methods: [tempo_client.charge()],
      })

      const { receipt } = await Actions.token.transferSync(client, {
        account: accounts[1],
        amount: BigInt(challenge.request.amount),
        memo: Base64.toHex(challenge.id) as Hex.Hex,
        to: challenge.request.recipient as Hex.Hex,
        token: challenge.request.currency as Hex.Hex,
      })

      const upperHash = `0x${receipt.transactionHash.slice(2).toUpperCase()}` as Hex.Hex

      const credential = Credential.from({
        challenge,
        payload: { hash: upperHash, type: 'hash' as const },
      })

      {
        const response = await fetch(httpServer.url, {
          headers: { Authorization: Credential.serialize(credential) },
        })
        expect(response.status).toBe(200)
      }

      httpServer.close()
    })

    test('behavior: rejects expired request', async () => {
      const httpServer = await Http.createServer(async (req, res) => {
        const result = await Mppx_server.toNodeListener(
          server.charge({
            amount: '1',
            expires: new Date(Date.now() - 1000).toISOString(),
          }),
        )(req, res)
        if (result.status === 402) return
        res.end('OK')
      })

      const response = await fetch(httpServer.url)
      expect(response.status).toBe(402)

      const challenge = Challenge.fromResponse(response, {
        methods: [tempo_client.charge()],
      })
      const request = challenge.request

      const { receipt } = await Actions.token.transferSync(client, {
        account: accounts[1],
        amount: BigInt(request.amount),
        memo: Base64.toHex(challenge.id) as Hex.Hex,
        to: request.recipient as Hex.Hex,
        token: request.currency as Hex.Hex,
      })

      const credential = Credential.from({
        challenge,
        payload: { hash: receipt.transactionHash, type: 'hash' as const },
      })

      {
        const response = await fetch(httpServer.url, {
          headers: { Authorization: Credential.serialize(credential) },
        })
        expect(response.status).toBe(402)
        const body = (await response.json()) as { detail: string }
        expect(body.detail).toMatch(/^Payment expired at /)
      }

      httpServer.close()
    })

    test('behavior: rejects when no client configured for chainId', async () => {
      const server = Mppx_server.create({
        methods: [
          tempo_server.charge({
            getClient({ chainId }: { chainId?: number | undefined }) {
              if (chainId === chain.id) return client
              throw new Error('not found')
            },
            currency: asset,
            account: accounts[0],
          }),
        ],
        realm,
        secretKey,
      })

      const httpServer = await Http.createServer(async (req, res) => {
        try {
          const result = await Mppx_server.toNodeListener(
            server.charge({
              amount: '1',
              chainId: 123456,
            }),
          )(req, res)
          if (result.status === 402) return
          res.end('OK')
        } catch (e) {
          res.statusCode = 500
          res.end((e as Error).message)
        }
      })

      const response = await fetch(httpServer.url)
      expect(response.status).toBe(500)
      expect(await response.text()).toMatchInlineSnapshot(
        `"No client configured with chainId 123456."`,
      )

      httpServer.close()
    })

    test('behavior: rejects when client not configured for chainId', async () => {
      const httpServer = await Http.createServer(async (req, res) => {
        try {
          const result = await Mppx_server.toNodeListener(
            server.charge({
              amount: '1',
              chainId: 999999,
            }),
          )(req, res)
          if (result.status === 402) return
          res.end('OK')
        } catch (e) {
          res.statusCode = 500
          res.end((e as Error).message)
        }
      })

      const response = await fetch(httpServer.url)
      expect(response.status).toBe(500)
      expect(await response.text()).toMatchInlineSnapshot(
        `"Client not configured with chainId 999999."`,
      )

      httpServer.close()
    })
  })

  describe('intent: charge; type: transaction; via Mppx', () => {
    test('behavior: rejects pull then push replay of the same transaction hash', async () => {
      const dedupServer = Mppx_server.create({
        methods: [
          tempo_server.charge({
            getClient() {
              return client
            },
            currency: asset,
            account: accounts[0],
            store: Store.memory(),
          }),
        ],
        realm,
        secretKey,
      })

      const pullClient = Mppx_client.create({
        polyfill: false,
        methods: [
          tempo_client({
            account: accounts[1],
            mode: 'pull',
            getClient() {
              return client
            },
          }),
        ],
      })

      const httpServer = await Http.createServer(async (req, res) => {
        const result = await Mppx_server.toNodeListener(
          dedupServer.charge({ amount: '1', currency: asset, recipient: accounts[0].address }),
        )(req, res)
        if (result.status === 402) return
        res.end('OK')
      })

      const challengeResponse = await fetch(httpServer.url)
      expect(challengeResponse.status).toBe(402)

      const pullCredentialSerialized = await pullClient.createCredential(challengeResponse)

      const pullAuthResponse = await fetch(httpServer.url, {
        headers: { Authorization: pullCredentialSerialized },
      })
      expect(pullAuthResponse.status).toBe(200)

      const pullReceipt = Receipt.fromResponse(pullAuthResponse)

      const replayChallengeResponse = await fetch(httpServer.url)
      expect(replayChallengeResponse.status).toBe(402)

      const replayChallenge = Challenge.fromResponse(replayChallengeResponse, {
        methods: [tempo_client.charge()],
      })

      const replayCredential = Credential.from({
        challenge: replayChallenge,
        payload: { hash: pullReceipt.reference as Hex.Hex, type: 'hash' as const },
      })

      const replayResponse = await fetch(httpServer.url, {
        headers: { Authorization: Credential.serialize(replayCredential) },
      })
      expect(replayResponse.status).toBe(402)
      const replayBody = (await replayResponse.json()) as { detail: string }
      expect(replayBody.detail).toContain('Transaction hash has already been used')

      httpServer.close()
    })

    test('behavior: rejects concurrent replay of same serialized transaction', async () => {
      const dedupServer = Mppx_server.create({
        methods: [
          tempo_server.charge({
            getClient() {
              return client
            },
            currency: asset,
            account: accounts[0],
            store: Store.memory(),
          }),
        ],
        realm,
        secretKey,
      })

      const mppx = Mppx_client.create({
        polyfill: false,
        methods: [
          tempo_client({
            account: accounts[1],
            getClient() {
              return client
            },
          }),
        ],
      })

      const httpServer = await Http.createServer(async (req, res) => {
        const result = await Mppx_server.toNodeListener(
          dedupServer.charge({ amount: '1', currency: asset, recipient: accounts[0].address }),
        )(req, res)
        if (result.status === 402) return
        res.end('OK')
      })

      // Get two challenges concurrently
      const [challengeResponse1, challengeResponse2] = await Promise.all([
        fetch(httpServer.url),
        fetch(httpServer.url),
      ])
      expect(challengeResponse1.status).toBe(402)
      expect(challengeResponse2.status).toBe(402)

      // Create credential from first challenge (signs transaction)
      const credential1 = await mppx.createCredential(challengeResponse1)

      // Extract the serialized tx and re-wrap it with the second challenge
      const decoded1 = Credential.deserialize(credential1)
      const challenge2 = Challenge.fromResponse(challengeResponse2, {
        methods: [tempo_client.charge()],
      })
      const credential2 = Credential.serialize(
        Credential.from({
          challenge: challenge2,
          payload: decoded1.payload,
        }),
      )

      // Submit SAME signed tx to both challenges concurrently
      const [resA, resB] = await Promise.all([
        fetch(httpServer.url, { headers: { Authorization: credential1 } }),
        fetch(httpServer.url, { headers: { Authorization: credential2 } }),
      ])

      const statuses = [resA.status, resB.status].sort()
      // One should succeed (200), the other should be rejected (402)
      expect(statuses).toEqual([200, 402])

      httpServer.close()
    })

    test('behavior: rejects malleable variants with different feePayerSignature', async () => {
      const dedupStore = Store.memory()
      const dedupServer = Mppx_server.create({
        methods: [
          tempo_server.charge({
            getClient() {
              return client
            },
            currency: asset,
            account: accounts[0],
            store: dedupStore,
          }),
        ],
        realm,
        secretKey,
      })

      const mppx = Mppx_client.create({
        polyfill: false,
        methods: [
          tempo_client({
            account: accounts[1],
            getClient() {
              return client
            },
          }),
        ],
      })

      const httpServer = await Http.createServer(async (req, res) => {
        const result = await Mppx_server.toNodeListener(
          dedupServer.charge({
            feePayer: accounts[0],
            amount: '1',
            currency: asset,
            recipient: accounts[0].address,
          }),
        )(req, res)
        if (result.status === 402) return
        res.end('OK')
      })

      // Get two challenges
      const challengeResponse1 = await fetch(httpServer.url)
      const challengeResponse2 = await fetch(httpServer.url)
      expect(challengeResponse1.status).toBe(402)
      expect(challengeResponse2.status).toBe(402)

      // Sign a transaction via the first challenge (produces 0x78 fee
      // payer format with sender address in feePayerSignatureOrSender).
      const credential1 = await mppx.createCredential(challengeResponse1)

      // Submit the original transaction, should succeed.
      const res1 = await fetch(httpServer.url, {
        headers: { Authorization: credential1 },
      })
      expect(res1.status).toBe(200)

      // Create a malleable variant of the SAME signed tx by
      // re-serializing in 0x76 format with feePayerSignature=null
      // (0x00 marker). Both deserialize to the same transaction
      // (same calls, signature, from), but the raw bytes differ so
      // keccak256 produces different hashes.
      const decoded1 = Credential.deserialize(credential1)
      const serializedTx = (decoded1.payload as { signature: string }).signature
      const deserialized = TxEnvelopeTempo.deserialize(serializedTx as TxEnvelopeTempo.Serialized)
      const malleableVariant = TxEnvelopeTempo.serialize(
        TxEnvelopeTempo.from({ ...deserialized, feePayerSignature: null }),
      )
      expect(malleableVariant).not.toEqual(serializedTx)

      // Wrap the malleable variant into the second challenge's credential
      const challenge2 = Challenge.fromResponse(challengeResponse2, {
        methods: [tempo_client.charge()],
      })
      const credential2 = Credential.serialize(
        Credential.from({
          challenge: challenge2,
          payload: { signature: malleableVariant, type: 'transaction' as const },
        }),
      )

      // Submit the malleable variant. It bypasses the old
      // keccak256(serializedTransaction) dedup (different raw bytes), but
      // the post-broadcast dedup on the tx hash catches duplicates.
      const res2 = await fetch(httpServer.url, {
        headers: { Authorization: credential2 },
      })
      expect(res2.status).toBe(402)

      httpServer.close()
    })

    test('default', async () => {
      const mppx = Mppx_client.create({
        polyfill: false,
        methods: [
          tempo_client({
            account: accounts[1],
            getClient() {
              return client
            },
          }),
        ],
      })

      const httpServer = await Http.createServer(async (req, res) => {
        const result = await Mppx_server.toNodeListener(
          server.charge({
            amount: '1',
            currency: asset,
            recipient: accounts[0].address,
          }),
        )(req, res)
        if (result.status === 402) return
        res.end('OK')
      })

      const response = await fetch(httpServer.url)
      expect(response.status).toBe(402)

      const credential = await mppx.createCredential(response)

      {
        const response = await fetch(httpServer.url, {
          headers: { Authorization: credential },
        })
        expect(response.status).toBe(200)

        const receipt = Receipt.fromResponse(response)
        expect({
          ...receipt,
          reference: '[reference]',
          timestamp: '[timestamp]',
        }).toMatchInlineSnapshot(`
            {
              "method": "tempo",
              "reference": "[reference]",
              "status": "success",
              "timestamp": "[timestamp]",
            }
          `)
      }

      httpServer.close()
    })

    test('behavior: overrides', async () => {
      const overrideRecipient = accounts[2].address
      const overrideCurrency = asset
      const overrideExpires = new Date(Date.now() + 60_000).toISOString()

      const mppx = Mppx_client.create({
        polyfill: false,
        methods: [
          tempo_client({
            account: accounts[1],
            getClient() {
              return client
            },
          }),
        ],
      })

      const httpServer = await Http.createServer(async (req, res) => {
        const result = await Mppx_server.toNodeListener(
          server.charge({
            amount: '1',
            currency: overrideCurrency,
            expires: overrideExpires,
            recipient: overrideRecipient,
          }),
        )(req, res)
        if (result.status === 402) return
        res.end('OK')
      })

      const response = await fetch(httpServer.url)
      expect(response.status).toBe(402)

      const credential = await mppx.createCredential(response)

      {
        const response = await fetch(httpServer.url, {
          headers: { Authorization: credential },
        })
        expect(response.status).toBe(200)

        const receipt = Receipt.fromResponse(response)
        expect(receipt.status).toBe('success')
      }

      httpServer.close()
    })

    test('behavior: fee payer', async () => {
      const mppx = Mppx_client.create({
        polyfill: false,
        methods: [
          tempo_client({
            account: accounts[1],
            getClient() {
              return client
            },
          }),
        ],
      })

      const httpServer = await Http.createServer(async (req, res) => {
        const result = await Mppx_server.toNodeListener(
          server.charge({
            feePayer: accounts[0],
            amount: '1',
            currency: asset,
            recipient: accounts[0].address,
          }),
        )(req, res)
        if (result.status === 402) return
        res.end('OK')
      })

      const response = await fetch(httpServer.url)
      expect(response.status).toBe(402)

      const credential = await mppx.createCredential(response)

      {
        const response = await fetch(httpServer.url, {
          headers: { Authorization: credential },
        })
        expect(response.status).toBe(200)

        const receipt = Receipt.fromResponse(response)
        expect({
          ...receipt,
          reference: '[reference]',
          timestamp: '[timestamp]',
        }).toMatchInlineSnapshot(`
            {
              "method": "tempo",
              "reference": "[reference]",
              "status": "success",
              "timestamp": "[timestamp]",
            }
          `)
      }

      httpServer.close()
    })

    test('behavior: fee payer (hoisted)', async () => {
      const mppx = Mppx_client.create({
        polyfill: false,
        methods: [
          tempo_client({
            account: accounts[1],
            getClient() {
              return client
            },
          }),
        ],
      })

      const server = Mppx_server.create({
        methods: [
          tempo_server.charge({
            account: accounts[0],
            getClient() {
              return client
            },
            currency: asset,
            feePayer: true,
          }),
        ],
        realm,
        secretKey,
      })

      const httpServer = await Http.createServer(async (req, res) => {
        const result = await Mppx_server.toNodeListener(
          server.charge({
            amount: '1',
            currency: asset,
            recipient: accounts[0].address,
          }),
        )(req, res)
        if (result.status === 402) return
        res.end('OK')
      })

      const response = await fetch(httpServer.url)
      expect(response.status).toBe(402)

      const credential = await mppx.createCredential(response)

      {
        const response = await fetch(httpServer.url, {
          headers: { Authorization: credential },
        })
        expect(response.status).toBe(200)

        const receipt = Receipt.fromResponse(response)
        expect({
          ...receipt,
          reference: '[reference]',
          timestamp: '[timestamp]',
        }).toMatchInlineSnapshot(`
            {
              "method": "tempo",
              "reference": "[reference]",
              "status": "success",
              "timestamp": "[timestamp]",
            }
          `)
      }

      httpServer.close()
    })

    test('behavior: fee payer URL (withFeePayer transport)', async () => {
      const feePayerHandler = Handler.feePayer({
        account: accounts[0],
        client,
      })
      const feePayerServer = await Http.createServer(feePayerHandler.listener)

      const serverWithFeePayer = Mppx_server.create({
        methods: [
          tempo_server.charge({
            feePayer: feePayerServer.url,
            getClient: () => client,
            currency: asset,
          }),
        ],
        realm,
        secretKey,
      })

      const mppx = Mppx_client.create({
        polyfill: false,
        methods: [
          tempo_client({
            account: accounts[1],
            getClient: () => client,
          }),
        ],
      })

      const httpServer = await Http.createServer(async (req, res) => {
        const result = await Mppx_server.toNodeListener(
          serverWithFeePayer.charge({
            amount: '1',
            currency: asset,
            recipient: accounts[0].address,
          }),
        )(req, res)
        if (result.status === 402) return
        res.end('OK')
      })

      const response = await mppx.fetch(httpServer.url)
      expect(response.status).toBe(200)

      const receipt = Receipt.fromResponse(response)
      expect(receipt.status).toBe('success')

      const txReceipt = await getTransactionReceipt(client, {
        hash: receipt.reference as Hex.Hex,
      })
      expect((txReceipt as any).feePayer).toBe(accounts[0].address.toLowerCase())

      httpServer.close()
      feePayerServer.close()
    })

    test('behavior: access keys', async () => {
      const rootAccount = accounts[1]
      const accessKey = Account.fromSecp256k1(Secp256k1.randomPrivateKey(), {
        access: rootAccount,
      })

      await Actions.accessKey.authorizeSync(client, {
        account: rootAccount,
        accessKey,
        feeToken: asset,
      })

      const mppx = Mppx_client.create({
        polyfill: false,
        methods: [
          tempo_client({
            account: accessKey,
            getClient() {
              return client
            },
          }),
        ],
      })

      const httpServer = await Http.createServer(async (req, res) => {
        const result = await Mppx_server.toNodeListener(
          server.charge({
            amount: '1',
            currency: asset,
            recipient: accounts[0].address,
          }),
        )(req, res)
        if (result.status === 402) return
        res.end('OK')
      })

      const response = await mppx.fetch(httpServer.url)
      expect(response.status).toBe(200)

      const receipt = Receipt.fromResponse(response)
      expect({
        ...receipt,
        reference: '[reference]',
        timestamp: '[timestamp]',
      }).toMatchInlineSnapshot(`
          {
            "method": "tempo",
            "reference": "[reference]",
            "status": "success",
            "timestamp": "[timestamp]",
          }
        `)

      httpServer.close()
    })

    test('behavior: access keys (fee payer)', async () => {
      const rootAccount = accounts[1]
      const accessKey = Account.fromSecp256k1(Secp256k1.randomPrivateKey(), {
        access: rootAccount,
      })

      await Actions.accessKey.authorizeSync(client, {
        account: rootAccount,
        accessKey,
        feeToken: asset,
      })

      const mppx = Mppx_client.create({
        polyfill: false,
        methods: [
          tempo_client({
            account: accessKey,
            getClient() {
              return client
            },
          }),
        ],
      })

      const server = Mppx_server.create({
        methods: [
          tempo_server({
            getClient() {
              return client
            },
            currency: asset,
            account: accounts[0],
            feePayer: true,
          }),
        ],
        realm,
        secretKey,
      })

      const httpServer = await Http.createServer(async (req, res) => {
        const result = await Mppx_server.toNodeListener(
          server.charge({
            amount: '1',
            currency: asset,
            recipient: accounts[0].address,
          }),
        )(req, res)
        if (result.status === 402) return
        res.end('OK')
      })

      const response = await mppx.fetch(httpServer.url)
      expect(response.status).toBe(200)

      const receipt = Receipt.fromResponse(response)
      expect({
        ...receipt,
        reference: '[reference]',
        timestamp: '[timestamp]',
      }).toMatchInlineSnapshot(`
          {
            "method": "tempo",
            "reference": "[reference]",
            "status": "success",
            "timestamp": "[timestamp]",
          }
        `)

      httpServer.close()
    })

    test('error: rejects fee-payer transaction with unauthorized calls', async () => {
      const httpServer = await Http.createServer(async (req, res) => {
        const result = await Mppx_server.toNodeListener(
          server.charge({
            feePayer: accounts[0],
            amount: '1',
            currency: asset,
            recipient: accounts[0].address,
          }),
        )(req, res)
        if (result.status === 402) return
        res.end('OK')
      })

      const response = await fetch(httpServer.url)
      expect(response.status).toBe(402)

      const challenge = Challenge.fromResponse(response, {
        methods: [tempo_client.charge()],
      })
      const request = challenge.request

      const memo = Attribution.encode({ serverId: challenge.realm })

      // Build a transaction with the valid transfer + a rogue extra call
      const transferCall = Actions.token.transfer.call({
        amount: BigInt(request.amount),
        memo,
        to: request.recipient as Hex.Hex,
        token: request.currency as Hex.Hex,
      })

      const rogueCall = {
        to: request.currency as `0x${string}`,
        data: encodeFunctionData({
          abi: Abis.tip20,
          functionName: 'transfer',
          args: [accounts[2]!.address, 1n],
        }),
      }

      const prepared = await prepareTransactionRequest(client, {
        account: accounts[1]!,
        calls: [transferCall, rogueCall],
        nonceKey: 'expiring',
      } as never)
      prepared.gas = prepared.gas! + 5_000n
      const signature = await signTransaction(client, prepared as never)

      const credential = Credential.from({
        challenge,
        payload: { signature, type: 'transaction' as const },
      })

      {
        const response = await fetch(httpServer.url, {
          headers: { Authorization: Credential.serialize(credential) },
        })
        // Server rejects the transaction — returns 402 (error caught by handler)
        expect(response.status).toBe(402)
      }

      httpServer.close()
    })

    test('error: rejects unsigned transaction (fee payer becomes sender)', async () => {
      const httpServer = await Http.createServer(async (req, res) => {
        const result = await Mppx_server.toNodeListener(
          server.charge({
            feePayer: accounts[0],
            amount: '1',
            currency: asset,
            recipient: accounts[0].address,
          }),
        )(req, res)
        if (result.status === 402) return
        res.end('OK')
      })

      const response = await fetch(httpServer.url)
      expect(response.status).toBe(402)

      const challenge = Challenge.fromResponse(response, {
        methods: [tempo_client.charge()],
      })
      const request = challenge.request

      // Craft an unsigned 0x76 transaction — no user signature.
      // This is the exact attack vector from the fee payer POC: without a
      // signature check the fee payer signs as both sender AND fee payer,
      // letting the attacker control the tx content.
      const unsignedTx = (await Transaction.serialize({
        calls: [
          {
            to: request.currency as `0x${string}`,
            data: encodeFunctionData({
              abi: Abis.tip20,
              functionName: 'transfer',
              args: [request.recipient as `0x${string}`, BigInt(request.amount)],
            }),
          },
        ],
        chainId: chain.id,
        gas: 100_000n,
        maxFeePerGas: 1_000_000_000n,
        maxPriorityFeePerGas: 1_000_000_000n,
        nonce: 0,
      } as never)) as string

      const credential = Credential.from({
        challenge,
        payload: { signature: unsignedTx, type: 'transaction' as const },
      })

      {
        const response = await fetch(httpServer.url, {
          headers: { Authorization: Credential.serialize(credential) },
        })
        expect(response.status).toBe(402)
        const body = (await response.json()) as { detail: string }
        expect(body.detail).toContain(
          'Transaction must be signed by the sender before fee payer co-signing.',
        )
      }

      httpServer.close()
    })

    test('error: rejects non-Tempo transaction type', async () => {
      const httpServer = await Http.createServer(async (req, res) => {
        const result = await Mppx_server.toNodeListener(
          server.charge({
            feePayer: accounts[0],
            amount: '1',
            currency: asset,
            recipient: accounts[0].address,
          }),
        )(req, res)
        if (result.status === 402) return
        res.end('OK')
      })

      const response = await fetch(httpServer.url)
      expect(response.status).toBe(402)

      const challenge = Challenge.fromResponse(response, {
        methods: [tempo_client.charge()],
      })

      // Submit a non-0x76 serialized transaction (e.g. EIP-1559 0x02 prefix)
      const fakeTx =
        '0x02f8650182a5bf843b9aca00843b9aca008252089400000000000000000000000000000000000000008080c001a00000000000000000000000000000000000000000000000000000000000000000a00000000000000000000000000000000000000000000000000000000000000000'

      const credential = Credential.from({
        challenge,
        payload: { signature: fakeTx, type: 'transaction' as const },
      })

      {
        const response = await fetch(httpServer.url, {
          headers: { Authorization: Credential.serialize(credential) },
        })
        expect(response.status).toBe(402)
        const body = (await response.json()) as { detail: string }
        expect(body.detail).toContain('Only Tempo (0x76/0x78) transactions are supported.')
      }

      httpServer.close()
    })
  })

  describe('intent: charge; type: transaction; defense-in-depth', () => {
    test('behavior: rejects pull transaction when receipt has no Transfer log', async () => {
      // Even when calldata looks correct, the server should verify that a Transfer
      // event actually appears in the on-chain receipt.
      // This guards against edge cases where calldata validation passes but the
      // transfer doesn't actually execute (e.g. contract upgrade, unexpected
      // silent no-op, or a bug in calldata matching).
      let interceptReceipt = false
      const interceptingClient = createClient({
        chain: client.chain,
        transport: custom({
          async request(args: any) {
            const result = await client.transport.request(args)
            if (interceptReceipt && args?.method === 'eth_sendRawTransactionSync') {
              return { ...(result as any), logs: [] }
            }
            return result
          },
        }),
      })

      const serverProxy = Mppx_server.create({
        methods: [
          tempo_server.charge({
            getClient() {
              return interceptingClient
            },
            currency: asset,
            account: accounts[0],
          }),
        ],
        realm,
        secretKey,
      })

      const mppx = Mppx_client.create({
        polyfill: false,
        methods: [
          tempo_client({
            account: accounts[1],
            mode: 'pull',
            getClient() {
              return client
            },
          }),
        ],
      })

      const httpServer = await Http.createServer(async (req, res) => {
        const result = await Mppx_server.toNodeListener(
          serverProxy.charge({
            amount: '1',
            currency: asset,
            recipient: accounts[0].address,
          }),
        )(req, res)
        if (result.status === 402) return
        res.end('OK')
      })

      const response = await fetch(httpServer.url)
      expect(response.status).toBe(402)

      const credential = await mppx.createCredential(response)

      // Enable interception so the receipt comes back with empty logs
      interceptReceipt = true

      const authResponse = await fetch(httpServer.url, {
        headers: { Authorization: credential },
      })

      // Should reject: receipt has no Transfer log proving the payment occurred
      expect(authResponse.status).toBe(402)
      const body = (await authResponse.json()) as { detail: string }
      expect(body.detail).toContain('no matching transfer with memo found')

      httpServer.close()
    })
  })

  describe('intent: charge; type: transaction; waitForConfirmation: false', () => {
    test('returns receipt without waiting for confirmation', async () => {
      const serverNoWait = Mppx_server.create({
        methods: [
          tempo_server.charge({
            getClient() {
              return client
            },
            currency: asset,
            account: accounts[0],
            waitForConfirmation: false,
          }),
        ],
        realm,
        secretKey,
      })

      const mppx = Mppx_client.create({
        polyfill: false,
        methods: [
          tempo_client({
            account: accounts[1],
            getClient() {
              return client
            },
          }),
        ],
      })

      const httpServer = await Http.createServer(async (req, res) => {
        const result = await Mppx_server.toNodeListener(
          serverNoWait.charge({
            amount: '1',
            currency: asset,
            recipient: accounts[0].address,
          }),
        )(req, res)
        if (result.status === 402) return
        res.end('OK')
      })

      const response = await fetch(httpServer.url)
      expect(response.status).toBe(402)

      const credential = await mppx.createCredential(response)

      {
        const response = await fetch(httpServer.url, {
          headers: { Authorization: credential },
        })
        expect(response.status).toBe(200)

        const receipt = Receipt.fromResponse(response)
        expect(receipt.status).toBe('success')
        expect(receipt.method).toBe('tempo')
        expect(receipt.reference).toBeDefined()
      }

      httpServer.close()
    })
  })

  describe('intent: unknown', () => {
    test('behavior: returns 402 for invalid payload schema', async () => {
      const httpServer = await Http.createServer(async (req, res) => {
        const result = await Mppx_server.toNodeListener(
          server.charge({
            amount: '1',
            expires: new Date(Date.now() + 60_000).toISOString(),
          }),
        )(req, res)
        if (result.status === 402) return
        res.end('OK')
      })

      const response = await fetch(httpServer.url)
      expect(response.status).toBe(402)

      const challenge = Challenge.fromResponse(response)

      const credential = Credential.from({
        challenge,
        payload: { type: 'unknown' as never },
      })

      {
        const response = await fetch(httpServer.url, {
          headers: { Authorization: Credential.serialize(credential) },
        })
        expect(response.status).toBe(402)
      }

      httpServer.close()
    })
  })

  describe('recipient/feePayer resolution', () => {
    test('recipient: string resolves to string', () => {
      const method = tempo_server.charge({
        getClient: () => client,
        account: accounts[0].address,
      })
      expect(method.defaults?.recipient).toBe(accounts[0].address)
    })

    test('recipient: Account resolves to account.address', () => {
      const method = tempo_server.charge({
        getClient: () => client,
        account: accounts[0],
      })
      expect(method.defaults?.recipient).toBe(accounts[0].address)
    })

    test('recipient: Account with feePayer: true resolves feePayer', async () => {
      const mppx = Mppx_client.create({
        polyfill: false,
        methods: [
          tempo_client.charge({
            account: accounts[1],
            getClient: () => client,
          }),
        ],
      })

      const server_ = Mppx_server.create({
        methods: [
          tempo_server.charge({
            account: accounts[0],
            getClient: () => client,
            currency: asset,
            feePayer: true,
          }),
        ],
        realm,
        secretKey,
      })

      const httpServer = await Http.createServer(async (req, res) => {
        const result = await Mppx_server.toNodeListener(server_.charge({ amount: '1' }))(req, res)
        if (result.status === 402) return
        res.end('OK')
      })

      const response = await mppx.fetch(httpServer.url)
      expect(response.status).toBe(200)

      httpServer.close()
    })

    test('recipient: string with feePayer: Account resolves separately', async () => {
      const mppx = Mppx_client.create({
        polyfill: false,
        methods: [
          tempo_client.charge({
            account: accounts[1],
            getClient: () => client,
          }),
        ],
      })

      const server_ = Mppx_server.create({
        methods: [
          tempo_server.charge({
            getClient: () => client,
            currency: asset,
            account: accounts[0].address,
            feePayer: accounts[0],
          }),
        ],
        realm,
        secretKey,
      })

      const httpServer = await Http.createServer(async (req, res) => {
        const result = await Mppx_server.toNodeListener(server_.charge({ amount: '1' }))(req, res)
        if (result.status === 402) return
        res.end('OK')
      })

      const response = await mppx.fetch(httpServer.url)
      expect(response.status).toBe(200)

      httpServer.close()
    })

    test('no feePayer resolves to undefined', () => {
      const method = tempo_server.charge({
        getClient: () => client,
        account: accounts[0].address,
      })
      expect(method.defaults?.recipient).toBe(accounts[0].address)
    })
  })

  describe('default currency resolution', () => {
    test('mainnet (default) resolves to USDC', () => {
      const method = tempo_server.charge({
        getClient: () => client,
        account: accounts[0].address,
      })
      expect((method.defaults as Record<string, unknown>)?.currency).toBe(
        '0x20C000000000000000000000b9537d11c60E8b50',
      )
    })

    test('testnet: true defaults to pathUSD', () => {
      const method = tempo_server.charge({
        getClient: () => client,
        account: accounts[0].address,
        testnet: true,
      })
      expect((method.defaults as Record<string, unknown>)?.currency).toBe(
        '0x20c0000000000000000000000000000000000000',
      )
    })

    test('unknown chain defaults to pathUSD', () => {
      const method = tempo_server.charge({
        getClient: () => client,
        account: accounts[0].address,
        chainId: 69420,
      })
      expect((method.defaults as Record<string, unknown>)?.currency).toBe(
        '0x20c0000000000000000000000000000000000000',
      )
    })

    test('explicit currency overrides default', () => {
      const method = tempo_server.charge({
        getClient: () => client,
        account: accounts[0].address,
        testnet: false,
        currency: '0xcustom',
      })
      expect(method.defaults?.currency).toBe('0xcustom')
    })

    test('decimals defaults to 6', () => {
      const method = tempo_server.charge({
        getClient: () => client,
        account: accounts[0].address,
      })
      expect((method.defaults as Record<string, unknown>)?.decimals).toBe(6)
    })

    test('challenge contains USDC currency (mainnet default)', async () => {
      const handler = Mppx_server.create({
        methods: [
          tempo_server.charge({
            getClient: () => client,
            account: accounts[0].address,
          }),
        ],
        realm,
        secretKey,
      })

      const result = await (handler.charge as Function)({ amount: '1' })(
        new Request('https://example.com'),
      )
      expect(result.status).toBe(402)
      if (result.status !== 402) throw new Error()

      const challenge = Challenge.fromResponse(result.challenge, {
        methods: [tempo_client.charge()],
      })
      expect(challenge.request.currency).toBe('0x20C000000000000000000000b9537d11c60E8b50')
    })

    test('challenge contains pathUSD currency when testnet: true', async () => {
      const handler = Mppx_server.create({
        methods: [
          tempo_server.charge({
            getClient: () => client,
            account: accounts[0].address,
            testnet: true,
          }),
        ],
        realm,
        secretKey,
      })

      const result = await (handler.charge as Function)({ amount: '1', chainId: chain.id })(
        new Request('https://example.com'),
      )
      expect(result.status).toBe(402)
      if (result.status !== 402) throw new Error()

      const challenge = Challenge.fromResponse(result.challenge, {
        methods: [tempo_client.charge()],
      })
      expect(challenge.request.currency).toBe('0x20c0000000000000000000000000000000000000')
    })

    test('challenge contains pathUSD currency (unknown chain)', async () => {
      const handler = Mppx_server.create({
        methods: [
          tempo_server.charge({
            getClient: () => client,
            account: accounts[0].address,
            chainId: 69420,
          }),
        ],
        realm,
        secretKey,
      })

      const result = await (handler.charge as Function)({ amount: '1' })(
        new Request('https://example.com'),
      )
      expect(result.status).toBe(402)
      if (result.status !== 402) throw new Error()

      const challenge = Challenge.fromResponse(result.challenge, {
        methods: [tempo_client.charge()],
      })
      expect(challenge.request.currency).toBe('0x20c0000000000000000000000000000000000000')
    })

    test('explicit currency in challenge overrides testnet default', async () => {
      const handler = Mppx_server.create({
        methods: [
          tempo_server.charge({
            getClient: () => client,
            account: accounts[0].address,
            testnet: false,
            currency: asset,
          }),
        ],
        realm,
        secretKey,
      })

      const result = await handler.charge({ amount: '1' })(new Request('https://example.com'))
      expect(result.status).toBe(402)
      if (result.status !== 402) throw new Error()

      const challenge = Challenge.fromResponse(result.challenge, {
        methods: [tempo_client.charge()],
      })
      expect(challenge.request.currency).toBe(asset)
    })
  })

  describe('attribution memo', () => {
    test('client uses challenge ID as memo (hash credential)', async () => {
      const httpServer = await Http.createServer(async (req, res) => {
        const result = await Mppx_server.toNodeListener(
          server.charge({ amount: '1', decimals: 6 }),
        )(req, res)
        if (result.status === 402) return
        res.end('OK')
      })

      const response = await fetch(httpServer.url)
      expect(response.status).toBe(402)

      const challenge = Challenge.fromResponse(response, {
        methods: [tempo_client.charge()],
      })

      expect(challenge.request.methodDetails?.memo).toBeUndefined()

      const memo = Base64.toHex(challenge.id) as Hex.Hex

      const { receipt } = await Actions.token.transferSync(client, {
        account: accounts[1],
        amount: BigInt(challenge.request.amount),
        memo,
        to: challenge.request.recipient as Hex.Hex,
        token: challenge.request.currency as Hex.Hex,
      })

      const credential = Credential.from({
        challenge,
        payload: { hash: receipt.transactionHash, type: 'hash' as const },
      })

      {
        const response = await fetch(httpServer.url, {
          headers: { Authorization: Credential.serialize(credential) },
        })
        expect(response.status).toBe(200)

        const paymentReceipt = Receipt.fromResponse(response)
        expect(paymentReceipt.status).toBe('success')
      }

      httpServer.close()
    })

    test('challenge ID memo works without clientId (hash credential)', async () => {
      const httpServer = await Http.createServer(async (req, res) => {
        const result = await Mppx_server.toNodeListener(
          server.charge({ amount: '1', decimals: 6 }),
        )(req, res)
        if (result.status === 402) return
        res.end('OK')
      })

      const response = await fetch(httpServer.url)
      expect(response.status).toBe(402)

      const challenge = Challenge.fromResponse(response, {
        methods: [tempo_client.charge()],
      })

      const memo = Base64.toHex(challenge.id) as Hex.Hex

      const { receipt } = await Actions.token.transferSync(client, {
        account: accounts[1],
        amount: BigInt(challenge.request.amount),
        memo,
        to: challenge.request.recipient as Hex.Hex,
        token: challenge.request.currency as Hex.Hex,
      })

      const credential = Credential.from({
        challenge,
        payload: { hash: receipt.transactionHash, type: 'hash' as const },
      })

      {
        const response = await fetch(httpServer.url, {
          headers: { Authorization: Credential.serialize(credential) },
        })
        expect(response.status).toBe(200)
      }

      httpServer.close()
    })

    test('client generates memo for transaction credential via Mppx', async () => {
      const mppx = Mppx_client.create({
        polyfill: false,
        methods: [
          tempo_client({
            account: accounts[1],
            clientId: 'test-app',
            getClient() {
              return client
            },
          }),
        ],
      })

      const httpServer = await Http.createServer(async (req, res) => {
        const result = await Mppx_server.toNodeListener(
          server.charge({
            amount: '1',
            currency: asset,
            recipient: accounts[0].address,
          }),
        )(req, res)
        if (result.status === 402) return
        res.end('OK')
      })

      const response = await mppx.fetch(httpServer.url)
      expect(response.status).toBe(200)

      httpServer.close()
    })

    test('rejects plain transfer without memo', async () => {
      const httpServer = await Http.createServer(async (req, res) => {
        const result = await Mppx_server.toNodeListener(
          server.charge({ amount: '1', decimals: 6 }),
        )(req, res)
        if (result.status === 402) return
        res.end('OK')
      })

      const response = await fetch(httpServer.url)
      expect(response.status).toBe(402)

      const challenge = Challenge.fromResponse(response, {
        methods: [tempo_client.charge()],
      })

      const { receipt } = await Actions.token.transferSync(client, {
        account: accounts[1],
        amount: BigInt(challenge.request.amount),
        to: challenge.request.recipient as Hex.Hex,
        token: challenge.request.currency as Hex.Hex,
      })

      const credential = Credential.from({
        challenge,
        payload: { hash: receipt.transactionHash, type: 'hash' as const },
      })

      {
        const response = await fetch(httpServer.url, {
          headers: { Authorization: Credential.serialize(credential) },
        })
        expect(response.status).toBe(402)
        const body = (await response.json()) as { detail: string }
        expect(body.detail).toContain('no matching transfer with memo found')
      }

      httpServer.close()
    })

    test('user-provided memo takes priority over attribution (store mode)', async () => {
      const userMemo =
        '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' as `0x${string}`

      const storeServer = Mppx_server.create({
        methods: [
          tempo_server.charge({
            getClient() {
              return client
            },
            currency: asset,
            account: accounts[0],
            store: Store.memory(),
          }),
        ],
        realm,
        secretKey,
      })

      const httpServer = await Http.createServer(async (req, res) => {
        const result = await Mppx_server.toNodeListener(
          storeServer.charge({ amount: '1', decimals: 6, memo: userMemo }),
        )(req, res)
        if (result.status === 402) return
        res.end('OK')
      })

      const response = await fetch(httpServer.url)
      expect(response.status).toBe(402)

      const challenge = Challenge.fromResponse(response, {
        methods: [tempo_client.charge()],
      })
      const memo = challenge.request.methodDetails?.memo as `0x${string}` | undefined
      expect(memo).toBe(userMemo)
      expect(Attribution.isMppMemo(memo!)).toBe(false)

      httpServer.close()
    })
  })

  describe('intent: charge; cross-challenge replay', () => {
    test('behavior: rejects hash replayed against a different challenge (push)', async () => {
      // A valid tx hash submitted with challenge A should NOT satisfy challenge B,
      // even without a store, because the on-chain memo is bound to challenge A.
      const httpServer = await Http.createServer(async (req, res) => {
        const result = await Mppx_server.toNodeListener(
          server.charge({ amount: '1', decimals: 6 }),
        )(req, res)
        if (result.status === 402) return
        res.end('OK')
      })

      // Get challenge A
      const responseA = await fetch(httpServer.url)
      expect(responseA.status).toBe(402)
      const challengeA = Challenge.fromResponse(responseA, {
        methods: [tempo_client.charge()],
      })

      // Create a valid transfer for challenge A (with challenge-ID memo)
      const memo = Base64.toHex(challengeA.id) as Hex.Hex
      const { receipt } = await Actions.token.transferSync(client, {
        account: accounts[1],
        amount: BigInt(challengeA.request.amount),
        memo,
        to: challengeA.request.recipient as Hex.Hex,
        token: challengeA.request.currency as Hex.Hex,
      })

      // Get a different challenge B
      const responseB = await fetch(httpServer.url)
      expect(responseB.status).toBe(402)
      const challengeB = Challenge.fromResponse(responseB, {
        methods: [tempo_client.charge()],
      })

      // Verify challenge IDs differ (different HMACs)
      expect(challengeA.id).not.toBe(challengeB.id)

      // Try to use the tx hash from challenge A with challenge B
      const credential = Credential.from({
        challenge: challengeB,
        payload: { hash: receipt.transactionHash, type: 'hash' as const },
      })

      const response = await fetch(httpServer.url, {
        headers: { Authorization: Credential.serialize(credential) },
      })
      expect(response.status).toBe(402)
      const body = (await response.json()) as { detail: string }
      expect(body.detail).toContain('no matching transfer')

      httpServer.close()
    })

    test('behavior: rejects hash with wrong memo value', async () => {
      // Transfer with an arbitrary memo that doesn't match the challenge's memo.
      const serverWithMemo = Mppx_server.create({
        methods: [
          tempo_server.charge({
            getClient() {
              return client
            },
            currency: asset,
            account: accounts[0],
          }),
        ],
        realm,
        secretKey,
      })

      const userMemo =
        '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' as `0x${string}`

      const httpServer = await Http.createServer(async (req, res) => {
        const result = await Mppx_server.toNodeListener(
          serverWithMemo.charge({ amount: '1', decimals: 6, memo: userMemo }),
        )(req, res)
        if (result.status === 402) return
        res.end('OK')
      })

      const response = await fetch(httpServer.url)
      expect(response.status).toBe(402)

      const challenge = Challenge.fromResponse(response, {
        methods: [tempo_client.charge()],
      })

      // Transfer with a DIFFERENT memo than what the challenge expects
      const wrongMemo =
        '0xcafebabecafebabecafebabecafebabecafebabecafebabecafebabecafebabe' as `0x${string}`

      const { receipt } = await Actions.token.transferSync(client, {
        account: accounts[1],
        amount: BigInt(challenge.request.amount),
        memo: wrongMemo as Hex.Hex,
        to: challenge.request.recipient as Hex.Hex,
        token: challenge.request.currency as Hex.Hex,
      })

      const credential = Credential.from({
        challenge,
        payload: { hash: receipt.transactionHash, type: 'hash' as const },
      })

      {
        const response = await fetch(httpServer.url, {
          headers: { Authorization: Credential.serialize(credential) },
        })
        expect(response.status).toBe(402)
        const body = (await response.json()) as { detail: string }
        expect(body.detail).toContain(
          'Payment verification failed: no matching transfer with memo found.',
        )
      }

      httpServer.close()
    })

    test('behavior: rejects credential with tampered challenge amount', async () => {
      // A client modifies the challenge's amount field before submitting.
      // The HMAC verification should reject this (challenge not issued by server).
      const httpServer = await Http.createServer(async (req, res) => {
        const result = await Mppx_server.toNodeListener(
          server.charge({ amount: '100', decimals: 6 }),
        )(req, res)
        if (result.status === 402) return
        res.end('OK')
      })

      const response = await fetch(httpServer.url)
      expect(response.status).toBe(402)

      const challenge = Challenge.fromResponse(response, {
        methods: [tempo_client.charge()],
      })

      // Pay the smaller amount
      const { receipt } = await Actions.token.transferSync(client, {
        account: accounts[1],
        amount: BigInt(1),
        to: challenge.request.recipient as Hex.Hex,
        token: challenge.request.currency as Hex.Hex,
      })

      // Tamper with the echoed challenge to claim a lower amount
      const tamperedChallenge = {
        ...challenge,
        request: { ...challenge.request, amount: '1' },
      }

      const credential = Credential.from({
        challenge: tamperedChallenge,
        payload: { hash: receipt.transactionHash, type: 'hash' as const },
      })

      {
        const response = await fetch(httpServer.url, {
          headers: { Authorization: Credential.serialize(credential) },
        })
        expect(response.status).toBe(402)
        const body = (await response.json()) as { detail: string }
        expect(body.detail).toContain('challenge was not issued by this server')
      }

      httpServer.close()
    })

    test('behavior: rejects credential from a different realm', async () => {
      // A credential obtained from server A should not work on server B
      // (different realm = different HMAC).
      const serverA = Mppx_server.create({
        methods: [
          tempo_server.charge({
            getClient() {
              return client
            },
            currency: asset,
            account: accounts[0],
          }),
        ],
        realm: 'server-a.example.com',
        secretKey,
      })

      const serverB = Mppx_server.create({
        methods: [
          tempo_server.charge({
            getClient() {
              return client
            },
            currency: asset,
            account: accounts[0],
          }),
        ],
        realm: 'server-b.example.com',
        secretKey,
      })

      // Get challenge from server A
      const httpServerA = await Http.createServer(async (req, res) => {
        const result = await Mppx_server.toNodeListener(
          serverA.charge({ amount: '1', decimals: 6 }),
        )(req, res)
        if (result.status === 402) return
        res.end('OK')
      })

      const responseA = await fetch(httpServerA.url)
      expect(responseA.status).toBe(402)

      const challengeA = Challenge.fromResponse(responseA, {
        methods: [tempo_client.charge()],
      })

      const { receipt } = await Actions.token.transferSync(client, {
        account: accounts[1],
        amount: BigInt(challengeA.request.amount),
        to: challengeA.request.recipient as Hex.Hex,
        token: challengeA.request.currency as Hex.Hex,
      })

      const credential = Credential.from({
        challenge: challengeA,
        payload: { hash: receipt.transactionHash, type: 'hash' as const },
      })

      // Submit to server B — should be rejected (realm mismatch)
      const httpServerB = await Http.createServer(async (req, res) => {
        const result = await Mppx_server.toNodeListener(
          serverB.charge({ amount: '1', decimals: 6 }),
        )(req, res)
        if (result.status === 402) return
        res.end('OK')
      })

      {
        const response = await fetch(httpServerB.url, {
          headers: { Authorization: Credential.serialize(credential) },
        })
        expect(response.status).toBe(402)
        const body = (await response.json()) as { detail: string }
        expect(body.detail).toContain('does not match')
      }

      httpServerA.close()
      httpServerB.close()
    })

    test('behavior: rejects credential with amount mismatch (cross-route)', async () => {
      // A credential obtained from a cheap route should not work on an expensive route.
      const httpServer = await Http.createServer(async (req, res) => {
        const url = new URL(req.url!, `http://${req.headers.host}`)
        const amount = url.pathname === '/cheap' ? '1' : '1000000'

        const result = await Mppx_server.toNodeListener(server.charge({ amount, decimals: 6 }))(
          req,
          res,
        )
        if (result.status === 402) return
        res.end('OK')
      })

      // Get a challenge for the cheap route
      const cheapResponse = await fetch(`${httpServer.url}/cheap`)
      expect(cheapResponse.status).toBe(402)

      const cheapChallenge = Challenge.fromResponse(cheapResponse, {
        methods: [tempo_client.charge()],
      })

      const { receipt } = await Actions.token.transferSync(client, {
        account: accounts[1],
        amount: BigInt(cheapChallenge.request.amount),
        to: cheapChallenge.request.recipient as Hex.Hex,
        token: cheapChallenge.request.currency as Hex.Hex,
      })

      const credential = Credential.from({
        challenge: cheapChallenge,
        payload: { hash: receipt.transactionHash, type: 'hash' as const },
      })

      // Submit to the expensive route — should be rejected
      {
        const response = await fetch(`${httpServer.url}/expensive`, {
          headers: { Authorization: Credential.serialize(credential) },
        })
        expect(response.status).toBe(402)
        const body = (await response.json()) as { detail: string }
        expect(body.detail).toContain('does not match')
      }

      httpServer.close()
    })

    test('behavior: rejects pull transaction with mismatched memo', async () => {
      // Pull mode: client signs a transferWithMemo with a memo that doesn't
      // match the challenge's expected memo. Server should reject.
      const userMemo =
        '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' as `0x${string}`

      const serverWithMemo = Mppx_server.create({
        methods: [
          tempo_server.charge({
            getClient() {
              return client
            },
            currency: asset,
            account: accounts[0],
          }),
        ],
        realm,
        secretKey,
      })

      const httpServer = await Http.createServer(async (req, res) => {
        const result = await Mppx_server.toNodeListener(
          serverWithMemo.charge({
            amount: '1',
            decimals: 6,
            memo: userMemo,
            currency: asset,
            recipient: accounts[0].address,
          }),
        )(req, res)
        if (result.status === 402) return
        res.end('OK')
      })

      const response = await fetch(httpServer.url)
      expect(response.status).toBe(402)

      const challenge = Challenge.fromResponse(response, {
        methods: [tempo_client.charge()],
      })

      // Manually construct a pull transaction with the WRONG memo
      const wrongMemo =
        '0xcafebabecafebabecafebabecafebabecafebabecafebabecafebabecafebabe' as `0x${string}`

      const transferCall = {
        to: challenge.request.currency as `0x${string}`,
        data: encodeFunctionData({
          abi: Abis.tip20,
          functionName: 'transferWithMemo',
          args: [
            challenge.request.recipient as `0x${string}`,
            BigInt(challenge.request.amount),
            wrongMemo,
          ],
        }),
      }

      const prepared = await prepareTransactionRequest(client, {
        account: accounts[1],
        calls: [transferCall],
        nonceKey: 'expiring',
      } as never)
      prepared.gas = prepared.gas! + 5_000n
      const signature = await signTransaction(client, prepared as never)

      const credential = Credential.from({
        challenge,
        payload: { signature, type: 'transaction' as const },
      })

      {
        const response = await fetch(httpServer.url, {
          headers: { Authorization: Credential.serialize(credential) },
        })
        expect(response.status).toBe(402)
        const body = (await response.json()) as { detail: string }
        expect(body.detail).toContain('no matching payment call found')
      }

      httpServer.close()
    })
  })

  describe('intent: charge; storeless replay protection', () => {
    test('behavior: rejects replayed hash with alternating case (storeless)', async () => {
      // Same attack as the store-mode case-variant test, but without a store.
      // Memo binding catches replays regardless of hash casing.
      const httpServer = await Http.createServer(async (req, res) => {
        const result = await Mppx_server.toNodeListener(
          server.charge({ amount: '1', decimals: 6 }),
        )(req, res)
        if (result.status === 402) return
        res.end('OK')
      })

      // Get challenge A, transfer with its challenge-ID memo
      const responseA = await fetch(httpServer.url)
      expect(responseA.status).toBe(402)
      const challengeA = Challenge.fromResponse(responseA, {
        methods: [tempo_client.charge()],
      })

      const { receipt } = await Actions.token.transferSync(client, {
        account: accounts[1],
        amount: BigInt(challengeA.request.amount),
        memo: Base64.toHex(challengeA.id) as Hex.Hex,
        to: challengeA.request.recipient as Hex.Hex,
        token: challengeA.request.currency as Hex.Hex,
      })

      // Get challenge B, replay with alternating-case hash
      const responseB = await fetch(httpServer.url)
      expect(responseB.status).toBe(402)
      const challengeB = Challenge.fromResponse(responseB, {
        methods: [tempo_client.charge()],
      })

      const hex = receipt.transactionHash.slice(2)
      const alternating = `0x${hex
        .split('')
        .map((c, i) => (i % 2 === 0 ? c.toUpperCase() : c.toLowerCase()))
        .join('')}` as Hex.Hex

      const credential = Credential.from({
        challenge: challengeB,
        payload: { hash: alternating, type: 'hash' as const },
      })

      // Rejected: on-chain memo is challengeA's ID, not challengeB's
      const response = await fetch(httpServer.url, {
        headers: { Authorization: Credential.serialize(credential) },
      })
      expect(response.status).toBe(402)
      const body = (await response.json()) as { detail: string }
      expect(body.detail).toContain('no matching transfer')

      httpServer.close()
    })

    test('behavior: rejects pull then push replay (storeless)', async () => {
      // Pull flow succeeds for challenge A. Attacker takes the resulting
      // tx hash and submits it as a push credential for challenge B.
      // Memo binding rejects because on-chain memo is challengeA's ID.
      const pullClient = Mppx_client.create({
        polyfill: false,
        methods: [
          tempo_client({
            account: accounts[1],
            mode: 'pull',
            getClient() {
              return client
            },
          }),
        ],
      })

      const httpServer = await Http.createServer(async (req, res) => {
        const result = await Mppx_server.toNodeListener(
          server.charge({ amount: '1', currency: asset, recipient: accounts[0].address }),
        )(req, res)
        if (result.status === 402) return
        res.end('OK')
      })

      // Pull flow for challenge A — succeeds
      const challengeResponse = await fetch(httpServer.url)
      expect(challengeResponse.status).toBe(402)

      const pullCredential = await pullClient.createCredential(challengeResponse)

      const pullResponse = await fetch(httpServer.url, {
        headers: { Authorization: pullCredential },
      })
      expect(pullResponse.status).toBe(200)

      const pullReceipt = Receipt.fromResponse(pullResponse)

      // Get challenge B, replay the tx hash as a push credential
      const replayChallengeResponse = await fetch(httpServer.url)
      expect(replayChallengeResponse.status).toBe(402)

      const replayChallenge = Challenge.fromResponse(replayChallengeResponse, {
        methods: [tempo_client.charge()],
      })

      const replayCredential = Credential.from({
        challenge: replayChallenge,
        payload: { hash: pullReceipt.reference as Hex.Hex, type: 'hash' as const },
      })

      const replayResponse = await fetch(httpServer.url, {
        headers: { Authorization: Credential.serialize(replayCredential) },
      })
      expect(replayResponse.status).toBe(402)
      const replayBody = (await replayResponse.json()) as { detail: string }
      expect(replayBody.detail).toContain('no matching transfer')

      httpServer.close()
    })

    test('behavior: rejects concurrent replay of same signed transaction (storeless)', async () => {
      // Same signed tx submitted against two different challenges concurrently.
      // Only the one matching the on-chain memo can succeed.
      const mppx = Mppx_client.create({
        polyfill: false,
        methods: [
          tempo_client({
            account: accounts[1],
            getClient() {
              return client
            },
          }),
        ],
      })

      const httpServer = await Http.createServer(async (req, res) => {
        const result = await Mppx_server.toNodeListener(
          server.charge({ amount: '1', currency: asset, recipient: accounts[0].address }),
        )(req, res)
        if (result.status === 402) return
        res.end('OK')
      })

      // Get two challenges concurrently
      const [challengeResponse1, challengeResponse2] = await Promise.all([
        fetch(httpServer.url),
        fetch(httpServer.url),
      ])
      expect(challengeResponse1.status).toBe(402)
      expect(challengeResponse2.status).toBe(402)

      // Create credential from first challenge (signs tx with challenge1's memo)
      const credential1 = await mppx.createCredential(challengeResponse1)

      // Extract the signed tx and re-wrap with second challenge
      const decoded1 = Credential.deserialize(credential1)
      const challenge2 = Challenge.fromResponse(challengeResponse2, {
        methods: [tempo_client.charge()],
      })
      const credential2 = Credential.serialize(
        Credential.from({
          challenge: challenge2,
          payload: decoded1.payload,
        }),
      )

      // Submit to both — only challenge1 can match the on-chain memo
      const [resA, resB] = await Promise.all([
        fetch(httpServer.url, { headers: { Authorization: credential1 } }),
        fetch(httpServer.url, { headers: { Authorization: credential2 } }),
      ])

      const statuses = [resA.status, resB.status].sort()
      expect(statuses).toEqual([200, 402])

      httpServer.close()
    })

    test('behavior: rejects malleable tx variants (storeless)', async () => {
      // Different serialized bytes (0x76 vs 0x78) produce different keccak256
      // hashes but the same on-chain tx. Without a store, memo binding catches
      // the replay because the on-chain memo is bound to challenge A's ID.
      const mppx = Mppx_client.create({
        polyfill: false,
        methods: [
          tempo_client({
            account: accounts[1],
            getClient() {
              return client
            },
          }),
        ],
      })

      const httpServer = await Http.createServer(async (req, res) => {
        const result = await Mppx_server.toNodeListener(
          server.charge({
            feePayer: accounts[0],
            amount: '1',
            currency: asset,
            recipient: accounts[0].address,
          }),
        )(req, res)
        if (result.status === 402) return
        res.end('OK')
      })

      // Get two challenges
      const challengeResponse1 = await fetch(httpServer.url)
      const challengeResponse2 = await fetch(httpServer.url)
      expect(challengeResponse1.status).toBe(402)
      expect(challengeResponse2.status).toBe(402)

      // Sign tx via first challenge (0x78 fee payer format)
      const credential1 = await mppx.createCredential(challengeResponse1)

      // Submit original — should succeed
      const res1 = await fetch(httpServer.url, {
        headers: { Authorization: credential1 },
      })
      expect(res1.status).toBe(200)

      // Create malleable variant: re-serialize in 0x76 format
      const decoded1 = Credential.deserialize(credential1)
      const serializedTx = (decoded1.payload as { signature: string }).signature
      const deserialized = TxEnvelopeTempo.deserialize(serializedTx as TxEnvelopeTempo.Serialized)
      const malleableVariant = TxEnvelopeTempo.serialize(
        TxEnvelopeTempo.from({ ...deserialized, feePayerSignature: null }),
      )
      expect(malleableVariant).not.toEqual(serializedTx)

      // Wrap malleable variant with challenge2's credential
      const challenge2 = Challenge.fromResponse(challengeResponse2, {
        methods: [tempo_client.charge()],
      })
      const credential2 = Credential.serialize(
        Credential.from({
          challenge: challenge2,
          payload: { signature: malleableVariant, type: 'transaction' as const },
        }),
      )

      // Submit — rejected because on-chain memo is challenge1's ID, not challenge2's
      const res2 = await fetch(httpServer.url, {
        headers: { Authorization: credential2 },
      })
      expect(res2.status).toBe(402)

      httpServer.close()
    })
  })

  describe('auto-swap', () => {
    // Use accounts[3] as payer with pathUsd only (no asset).
    // Use accounts[4] as payer with zero balance.
    const swapPayer = accounts[3]!
    const brokePayer = accounts[4]!

    beforeAll(async () => {
      // Fund swap payer with pathUsd only
      await fundAccount({ address: swapPayer.address, token: Addresses.pathUsd as Hex.Hex })

      // Seed DEX liquidity: create pair, then place a sell order for `asset`.
      await Actions.dex.createPair(client, {
        account: accounts[0]!,
        base: asset,
      })
      await fundAccount({ address: accounts[0]!.address, token: asset })
      await Actions.token.approveSync(client, {
        account: accounts[0]!,
        token: asset,
        spender: Addresses.stablecoinDex,
        amount: parseUnits('1000', 6),
      })
      await Actions.dex.placeSync(client, {
        account: accounts[0]!,
        token: asset,
        amount: parseUnits('1000', 6),
        type: 'sell',
        tick: Tick.fromPrice('1.001'),
      })
    })

    test('swaps via DEX when user lacks target currency', async () => {
      const mppx = Mppx_client.create({
        polyfill: false,
        methods: [
          tempo_client({
            account: swapPayer,
            autoSwap: true,
            getClient() {
              return client
            },
          }),
        ],
      })

      const httpServer = await Http.createServer(async (req, res) => {
        const result = await Mppx_server.toNodeListener(
          server.charge({
            amount: '1',
            currency: asset,
            recipient: accounts[0]!.address,
          }),
        )(req, res)
        if (result.status === 402) return
        res.end('OK')
      })

      const response = await mppx.fetch(httpServer.url)
      expect(response.status).toBe(200)

      const receipt = Receipt.fromResponse(response)
      expect(receipt.status).toBe('success')
      expect(receipt.method).toBe('tempo')

      httpServer.close()
    })

    test('direct transfer when user has target currency', async () => {
      const mppx = Mppx_client.create({
        polyfill: false,
        methods: [
          tempo_client({
            account: accounts[1]!,
            autoSwap: true,
            getClient() {
              return client
            },
          }),
        ],
      })

      const httpServer = await Http.createServer(async (req, res) => {
        const result = await Mppx_server.toNodeListener(
          server.charge({
            amount: '1',
            currency: asset,
            recipient: accounts[0]!.address,
          }),
        )(req, res)
        if (result.status === 402) return
        res.end('OK')
      })

      const response = await mppx.fetch(httpServer.url)
      expect(response.status).toBe(200)

      const receipt = Receipt.fromResponse(response)
      expect(receipt.status).toBe('success')

      httpServer.close()
    })

    test('custom slippage and tokenIn', async () => {
      const mppx = Mppx_client.create({
        polyfill: false,
        methods: [
          tempo_client({
            account: swapPayer,
            autoSwap: {
              slippage: 2,
              tokenIn: [Addresses.pathUsd],
            },
            getClient() {
              return client
            },
          }),
        ],
      })

      const httpServer = await Http.createServer(async (req, res) => {
        const result = await Mppx_server.toNodeListener(
          server.charge({
            amount: '1',
            currency: asset,
            recipient: accounts[0]!.address,
          }),
        )(req, res)
        if (result.status === 402) return
        res.end('OK')
      })

      const response = await mppx.fetch(httpServer.url)
      expect(response.status).toBe(200)

      httpServer.close()
    })

    test('autoSwap enabled via fetch context', async () => {
      const mppx = Mppx_client.create({
        polyfill: false,
        methods: [
          tempo_client({
            account: swapPayer,
            getClient() {
              return client
            },
          }),
        ],
      })

      const httpServer = await Http.createServer(async (req, res) => {
        const result = await Mppx_server.toNodeListener(
          server.charge({
            amount: '1',
            currency: asset,
            recipient: accounts[0]!.address,
          }),
        )(req, res)
        if (result.status === 402) return
        res.end('OK')
      })

      const response = await mppx.fetch(httpServer.url, {
        context: { autoSwap: true },
      })
      expect(response.status).toBe(200)

      const receipt = Receipt.fromResponse(response)
      expect(receipt.status).toBe('success')

      httpServer.close()
    })

    test('autoSwap with custom options via fetch context', async () => {
      const mppx = Mppx_client.create({
        polyfill: false,
        methods: [
          tempo_client({
            account: swapPayer,
            getClient() {
              return client
            },
          }),
        ],
      })

      const httpServer = await Http.createServer(async (req, res) => {
        const result = await Mppx_server.toNodeListener(
          server.charge({
            amount: '1',
            currency: asset,
            recipient: accounts[0]!.address,
          }),
        )(req, res)
        if (result.status === 402) return
        res.end('OK')
      })

      const response = await mppx.fetch(httpServer.url, {
        context: {
          autoSwap: { slippage: 2, tokenIn: [Addresses.pathUsd] },
        },
      })
      expect(response.status).toBe(200)

      httpServer.close()
    })

    test('error: throws when no fallback currency has sufficient balance', async () => {
      const mppx = Mppx_client.create({
        polyfill: false,
        methods: [
          tempo_client({
            account: brokePayer,
            autoSwap: true,
            getClient() {
              return client
            },
          }),
        ],
      })

      const httpServer = await Http.createServer(async (req, res) => {
        const result = await Mppx_server.toNodeListener(
          server.charge({
            amount: '1',
            currency: asset,
            recipient: accounts[0]!.address,
          }),
        )(req, res)
        if (result.status === 402) return
        res.end('OK')
      })

      await expect(mppx.fetch(httpServer.url)).rejects.toThrow('Insufficient funds')

      httpServer.close()
    })

    test('error: throws when amount exceeds swap liquidity', async () => {
      const mppx = Mppx_client.create({
        polyfill: false,
        methods: [
          tempo_client({
            account: swapPayer,
            autoSwap: true,
            getClient() {
              return client
            },
          }),
        ],
      })

      const httpServer = await Http.createServer(async (req, res) => {
        const result = await Mppx_server.toNodeListener(
          server.charge({
            amount: '999999999',
            currency: asset,
            recipient: accounts[0]!.address,
          }),
        )(req, res)
        if (result.status === 402) return
        res.end('OK')
      })

      await expect(mppx.fetch(httpServer.url)).rejects.toThrow('Insufficient funds')

      httpServer.close()
    })

    test('error: throws when tokenIn list has no viable candidates', async () => {
      const bogusToken = '0x0000000000000000000000000000000000099999' as const

      const mppx = Mppx_client.create({
        polyfill: false,
        methods: [
          tempo_client({
            account: brokePayer,
            autoSwap: { tokenIn: [bogusToken] },
            getClient() {
              return client
            },
          }),
        ],
      })

      const httpServer = await Http.createServer(async (req, res) => {
        const result = await Mppx_server.toNodeListener(
          server.charge({
            amount: '1',
            currency: asset,
            recipient: accounts[0]!.address,
          }),
        )(req, res)
        if (result.status === 402) return
        res.end('OK')
      })

      await expect(mppx.fetch(httpServer.url)).rejects.toThrow('Insufficient funds')

      httpServer.close()
    })
  })
})
