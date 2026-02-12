import { Challenge, Credential, Receipt } from 'mpay'
import { Mpay as Mpay_client, tempo as tempo_client } from 'mpay/client'
import { Mpay as Mpay_server, tempo as tempo_server } from 'mpay/server'
import type { Hex } from 'ox'
import { Actions } from 'viem/tempo'
import { describe, expect, test } from 'vitest'
import * as Http from '~test/Http.js'
import { accounts, asset, chain, client } from '~test/tempo/viem.js'
import * as Attribution from '../Attribution.js'

const realm = 'api.example.com'
const secretKey = 'test-secret-key'

const server = Mpay_server.create({
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
      const httpServer = await Http.createServer(async (req, res) => {
        const result = await Mpay_server.toNodeListener(
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
      const request = challenge.request
      expect(request.methodDetails?.chainId).toBe(chain.id)

      const memo = Attribution.encode({ realm: challenge.realm }) as Hex.Hex

      const { receipt } = await Actions.token.transferSync(client, {
        account: accounts[1],
        amount: BigInt(request.amount),
        memo,
        to: request.recipient as Hex.Hex,
        token: request.currency as Hex.Hex,
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
        const result = await Mpay_server.toNodeListener(
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

      const challenge = Challenge.fromResponse(response, {
        methods: [tempo_client.charge()],
      })
      const request = challenge.request
      expect(request.recipient).toBe(overrideRecipient)
      expect(request.currency).toBe(overrideCurrency)
      expect(request.expires).toBe(overrideExpires)

      const memo = Attribution.encode({ realm: challenge.realm }) as Hex.Hex

      const { receipt } = await Actions.token.transferSync(client, {
        account: accounts[1],
        amount: BigInt(request.amount),
        memo,
        to: request.recipient as Hex.Hex,
        token: request.currency as Hex.Hex,
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

      const serverNoAttribution = Mpay_server.create({
        methods: [
          tempo_server.charge({
            getClient() {
              return client
            },
            currency: asset,
            account: accounts[0],
            attribution: false,
          }),
        ],
        realm,
        secretKey,
      })

      const httpServer = await Http.createServer(async (req, res) => {
        const result = await Mpay_server.toNodeListener(
          serverNoAttribution.charge({ amount: '1' }),
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
        expect(body.detail).toContain('Payment verification failed: no matching transfer found.')
      }

      httpServer.close()
    })

    test('behavior: rejects expired request', async () => {
      const httpServer = await Http.createServer(async (req, res) => {
        const result = await Mpay_server.toNodeListener(
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
      const server = Mpay_server.create({
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
          const result = await Mpay_server.toNodeListener(
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
          const result = await Mpay_server.toNodeListener(
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

  describe('intent: charge; type: transaction; via Mpay', () => {
    test('default', async () => {
      const mpay = Mpay_client.create({
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
        const result = await Mpay_server.toNodeListener(
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
        const result = await Mpay_server.toNodeListener(
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
        const result = await Mpay_server.toNodeListener(
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

      const server = Mpay_server.create({
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
        const result = await Mpay_server.toNodeListener(
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
  })

  describe('intent: unknown', () => {
    test('behavior: returns 402 for invalid payload schema', async () => {
      const httpServer = await Http.createServer(async (req, res) => {
        const result = await Mpay_server.toNodeListener(
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
      const mpay = Mpay_client.create({
        polyfill: false,
        methods: [
          tempo_client.charge({
            account: accounts[1],
            getClient: () => client,
          }),
        ],
      })

      const server_ = Mpay_server.create({
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
        const result = await Mpay_server.toNodeListener(server_.charge({ amount: '1' }))(req, res)
        if (result.status === 402) return
        res.end('OK')
      })

      const response = await mpay.fetch(httpServer.url)
      expect(response.status).toBe(200)

      httpServer.close()
    })

    test('recipient: string with feePayer: Account resolves separately', async () => {
      const mpay = Mpay_client.create({
        polyfill: false,
        methods: [
          tempo_client.charge({
            account: accounts[1],
            getClient: () => client,
          }),
        ],
      })

      const server_ = Mpay_server.create({
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
        const result = await Mpay_server.toNodeListener(server_.charge({ amount: '1' }))(req, res)
        if (result.status === 402) return
        res.end('OK')
      })

      const response = await mpay.fetch(httpServer.url)
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

  describe('attribution memo', () => {
    test('client always generates attribution memo (hash credential)', async () => {
      const httpServer = await Http.createServer(async (req, res) => {
        const result = await Mpay_server.toNodeListener(
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

      const memo = Attribution.encode({ realm: challenge.realm, client: 'test-app' })
      expect(Attribution.isMppMemo(memo)).toBe(true)
      expect(Attribution.verifyServer(memo, realm)).toBe(true)

      const { receipt } = await Actions.token.transferSync(client, {
        account: accounts[1],
        amount: BigInt(challenge.request.amount),
        memo: memo as Hex.Hex,
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

    test('anonymous client (no slug) generates valid attribution memo', async () => {
      const httpServer = await Http.createServer(async (req, res) => {
        const result = await Mpay_server.toNodeListener(
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

      const memo = Attribution.encode({ realm: challenge.realm })
      const decoded = Attribution.decode(memo)
      expect(decoded).not.toBeNull()
      expect(decoded!.client).toBeNull()

      const { receipt } = await Actions.token.transferSync(client, {
        account: accounts[1],
        amount: BigInt(challenge.request.amount),
        memo: memo as Hex.Hex,
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

    test('client generates memo for transaction credential via Mpay', async () => {
      const mpay = Mpay_client.create({
        polyfill: false,
        methods: [
          tempo_client({
            account: accounts[1],
            slug: 'test-app',
            getClient() {
              return client
            },
          }),
        ],
      })

      const httpServer = await Http.createServer(async (req, res) => {
        const result = await Mpay_server.toNodeListener(
          server.charge({
            amount: '1',
            currency: asset,
            recipient: accounts[0].address,
          }),
        )(req, res)
        if (result.status === 402) return
        res.end('OK')
      })

      const response = await mpay.fetch(httpServer.url)
      expect(response.status).toBe(200)

      httpServer.close()
    })

    test('attribution: false skips memo verification on server', async () => {
      const serverNoAttribution = Mpay_server.create({
        methods: [
          tempo_server.charge({
            getClient() {
              return client
            },
            currency: asset,
            account: accounts[0],
            attribution: false,
          }),
        ],
        realm,
        secretKey,
      })

      const httpServer = await Http.createServer(async (req, res) => {
        const result = await Mpay_server.toNodeListener(
          serverNoAttribution.charge({ amount: '1', decimals: 6 }),
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
        expect(response.status).toBe(200)
      }

      httpServer.close()
    })

    test('user-provided memo takes priority over attribution', async () => {
      const userMemo =
        '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' as `0x${string}`

      const httpServer = await Http.createServer(async (req, res) => {
        const result = await Mpay_server.toNodeListener(
          server.charge({ amount: '1', decimals: 6, memo: userMemo }),
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
})
