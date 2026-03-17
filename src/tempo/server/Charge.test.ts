import { Challenge, Credential, Receipt } from 'mppx'
import { Mppx as Mppx_client, tempo as tempo_client } from 'mppx/client'
import { Mppx as Mppx_server, tempo as tempo_server } from 'mppx/server'
import type { Hex } from 'ox'
import { Handler } from 'tempo.ts/server'
import { encodeFunctionData, parseUnits } from 'viem'
import { getTransactionReceipt, prepareTransactionRequest, signTransaction } from 'viem/actions'
import { Abis, Actions, Addresses, Tick } from 'viem/tempo'
import { beforeAll, describe, expect, test } from 'vitest'
import * as Http from '~test/Http.js'
import { accounts, asset, chain, client, fundAccount } from '~test/tempo/viem.js'
import * as Attribution from '../Attribution.js'

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
        account: accounts[0] as any,
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
    test('client always generates attribution memo (hash credential)', async () => {
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

      const memo = Attribution.encode({ serverId: challenge.realm, clientId: 'test-app' })
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

    test('anonymous client (no clientId) generates valid attribution memo', async () => {
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

      const memo = Attribution.encode({ serverId: challenge.realm })
      const decoded = Attribution.decode(memo)
      expect(decoded).not.toBeNull()
      expect(decoded!.clientFingerprint).toBeNull()

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

    test('server accepts plain transfer without memo', async () => {
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
        expect(response.status).toBe(200)
      }

      httpServer.close()
    })

    test('user-provided memo takes priority over attribution', async () => {
      const userMemo =
        '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' as `0x${string}`

      const httpServer = await Http.createServer(async (req, res) => {
        const result = await Mppx_server.toNodeListener(
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
