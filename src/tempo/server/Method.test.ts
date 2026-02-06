import type { Hex } from 'ox'
import { Actions } from 'viem/tempo'
import { describe, expect, test } from 'vitest'
import * as Http from '~test/Http.js'
import { rpcUrl } from '~test/tempo/prool.js'
import { accounts, asset, chain, client } from '~test/tempo/viem.js'
import * as Challenge from '../../Challenge.js'
import * as Credential from '../../Credential.js'
import * as Mpay_client from '../../client/Mpay.js'
import * as Receipt from '../../Receipt.js'
import * as Mpay_server from '../../server/Mpay.js'
import { toNodeListener } from '../../server/Mpay.js'
import * as Methods_client from '../client/Method.js'
import * as Methods_server from './Method.js'

const realm = 'api.example.com'
const secretKey = 'test-secret-key'

const server = Mpay_server.create({
  methods: [
    Methods_server.tempo({
      client() {
        return client
      },
      currency: asset,
      recipient: accounts[0].address,
    }),
  ],
  realm,
  secretKey,
})

describe('tempo', () => {
  describe('intent: charge; type: hash', () => {
    test('default', async () => {
      const httpServer = await Http.createServer(async (req, res) => {
        const result = await toNodeListener(server.charge({ amount: '1', decimals: 6 }))(req, res)
        if (result.status === 402) return
        res.end('OK')
      })

      const response = await fetch(httpServer.url)
      expect(response.status).toBe(402)

      const challenge = Challenge.fromResponse(response, { method: server.methods[0] })
      expect(challenge.request.methodDetails?.chainId).toBe(chain.id)

      const { receipt } = await Actions.token.transferSync(client, {
        account: accounts[1],
        amount: BigInt(challenge.request.amount),
        to: challenge.request.recipient as Hex.Hex,
        token: challenge.request.currency as Hex.Hex,
      })
      const hash = receipt.transactionHash

      const credential = Credential.from({
        challenge,
        payload: { hash, type: 'hash' as const },
      })

      {
        const response = await fetch(httpServer.url, {
          headers: { Authorization: Credential.serialize(credential) },
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

      const httpServer = await Http.createServer(async (req, res) => {
        const result = await toNodeListener(
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

      const challenge = Challenge.fromResponse(response, { method: server.methods[0] })
      expect(challenge.request.recipient).toBe(overrideRecipient)
      expect(challenge.request.currency).toBe(overrideCurrency)
      expect(challenge.request.expires).toBe(overrideExpires)

      const { receipt } = await Actions.token.transferSync(client, {
        account: accounts[1],
        amount: BigInt(challenge.request.amount),
        to: challenge.request.recipient as Hex.Hex,
        token: challenge.request.currency as Hex.Hex,
      })
      const hash = receipt.transactionHash

      const credential = Credential.from({
        challenge,
        payload: { hash, type: 'hash' as const },
      })

      {
        const response = await fetch(httpServer.url, {
          headers: { Authorization: Credential.serialize(credential) },
        })
        expect(response.status).toBe(200)

        const receipt = Receipt.fromResponse(response)
        expect(receipt.status).toBe('success')
      }

      httpServer.close()
    })

    test('behavior: rejects hash with non-matching Transfer log', async () => {
      const wrongRecipient = accounts[2].address

      const httpServer = await Http.createServer(async (req, res) => {
        const result = await toNodeListener(server.charge({ amount: '1' }))(req, res)
        if (result.status === 402) return
        res.end('OK')
      })

      const response = await fetch(httpServer.url)
      expect(response.status).toBe(402)

      const challenge = Challenge.fromResponse(response, { method: server.methods[0] })

      const { receipt } = await Actions.token.transferSync(client, {
        account: accounts[1],
        amount: BigInt(challenge.request.amount),
        to: wrongRecipient,
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
        expect(body.detail).toContain('Payment verification failed: no matching transfer found.')
      }

      httpServer.close()
    })

    test('behavior: rejects expired request', async () => {
      const httpServer = await Http.createServer(async (req, res) => {
        const result = await toNodeListener(
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

      const challenge = Challenge.fromResponse(response, { method: server.methods[0] })

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
        expect(body.detail).toBe('Payment verification failed: Payment request expired.')
      }

      httpServer.close()
    })

    test('behavior: rejects when chainId has no RPC URL configured', async () => {
      const httpServer = await Http.createServer(async (req, res) => {
        try {
          const result = await toNodeListener(
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
        `"No RPC URL configured for chainId 999999."`,
      )

      httpServer.close()
    })
  })

  describe('intent: charge; type: transaction; via Mpay', () => {
    test('default', async () => {
      const mpay = Mpay_client.create({
        methods: [
          Methods_client.tempo({
            account: accounts[1],
            rpcUrl: { [chain.id]: rpcUrl },
          }),
        ],
      })

      const httpServer = await Http.createServer(async (req, res) => {
        const result = await toNodeListener(
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

      const credential = await mpay.createCredential(response)

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

      const mpay = Mpay_client.create({
        methods: [
          Methods_client.tempo({
            account: accounts[1],
            rpcUrl: { [chain.id]: rpcUrl },
          }),
        ],
      })

      const httpServer = await Http.createServer(async (req, res) => {
        const result = await toNodeListener(
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

      const credential = await mpay.createCredential(response)

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
      const mpay = Mpay_client.create({
        methods: [
          Methods_client.tempo({
            account: accounts[1],
            client() {
              return client
            },
          }),
        ],
      })

      const httpServer = await Http.createServer(async (req, res) => {
        const result = await toNodeListener(
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

      const credential = await mpay.createCredential(response)

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
      const mpay = Mpay_client.create({
        methods: [
          Methods_client.tempo({
            account: accounts[1],
            rpcUrl: { [chain.id]: rpcUrl },
          }),
        ],
      })

      const server = Mpay_server.create({
        methods: [
          Methods_server.tempo({
            currency: asset,
            feePayer: accounts[0],
            recipient: accounts[0].address,
            rpcUrl: { [chain.id]: rpcUrl },
          }),
        ],
        realm,
        secretKey,
      })

      const httpServer = await Http.createServer(async (req, res) => {
        const result = await toNodeListener(
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

      const credential = await mpay.createCredential(response)

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

    test('behavior: routes to correct chain based on chainId', async () => {
      const server = Mpay_server.create({
        methods: [
          Methods_server.tempo({
            currency: asset,
            recipient: accounts[0].address,
            rpcUrl: { [chain.id]: rpcUrl, 999999: 'https://other-chain.example.com' },
          }),
        ],
        realm,
        secretKey,
      })

      const client = Mpay_client.create({
        methods: [
          Methods_client.tempo({
            account: accounts[1],
            rpcUrl: { [chain.id]: rpcUrl, 999999: 'https://other-chain.example.com' },
          }),
        ],
      })

      const httpServer = await Http.createServer(async (req, res) => {
        const result = await toNodeListener(
          server.charge({
            amount: '1',
            chainId: chain.id,
          }),
        )(req, res)
        if (result.status === 402) return
        res.end('OK')
      })

      const response = await fetch(httpServer.url)
      expect(response.status).toBe(402)

      const challenge = Challenge.fromResponse(response, { method: server.methods[0] })
      expect(challenge.request.methodDetails?.chainId).toBe(chain.id)

      const credential = await client.createCredential(response)

      {
        const response = await fetch(httpServer.url, {
          headers: { Authorization: credential },
        })
        expect(response.status).toBe(200)
      }

      httpServer.close()
    })
  })

  describe('intent: unknown', () => {
    test('behavior: returns 402 for invalid payload schema', async () => {
      const httpServer = await Http.createServer(async (req, res) => {
        const result = await toNodeListener(
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

      const challenge = Challenge.fromResponse(response, { method: server.methods[0] })

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
})
