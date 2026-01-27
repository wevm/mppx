import { describe, expect, test } from 'vitest'
import * as Http from '~test/Http.js'
import { rpcUrl } from '~test/tempo/prool.js'
import { accounts, asset, chain } from '~test/tempo/viem.js'
import * as Receipt from '../Receipt.js'
import * as Mpay_server from '../server/Mpay.js'
import { toNodeListener } from '../server/Mpay.js'
import * as Methods_client from '../tempo/client/Method.js'
import * as Methods_server from '../tempo/server/Method.js'
import * as Fetch from './Fetch.js'

const realm = 'api.example.com'
const secretKey = 'test-secret-key'

const server = Mpay_server.create({
  method: Methods_server.tempo({
    chainId: chain.id,
    rpcUrl,
  }),
  realm,
  secretKey,
})

describe('Fetch.from', () => {
  test('default: account at creation', async () => {
    const fetch = Fetch.from({
      methods: [
        Methods_client.tempo({
          account: accounts[1],
          chainId: chain.id,
          rpcUrl,
        }),
      ],
    })

    const httpServer = await Http.createServer(async (req, res) => {
      const result = await toNodeListener(
        server.charge({
          request: {
            amount: '1000000',
            currency: asset,
            expires: new Date(Date.now() + 60_000).toISOString(),
            recipient: accounts[0].address,
          },
        }),
      )(req, res)
      if (result.status === 402) return
      res.end('OK')
    })

    const response = await fetch(httpServer.url)
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

  test('default: account via context', async () => {
    const fetch = Fetch.from({
      methods: [
        Methods_client.tempo({
          chainId: chain.id,
          rpcUrl,
        }),
      ],
    })

    const httpServer = await Http.createServer(async (req, res) => {
      const result = await toNodeListener(
        server.charge({
          request: {
            amount: '1000000',
            currency: asset,
            expires: new Date(Date.now() + 60_000).toISOString(),
            recipient: accounts[0].address,
          },
        }),
      )(req, res)
      if (result.status === 402) return
      res.end('OK')
    })

    const response = await fetch(httpServer.url, {
      context: { account: accounts[1] },
    })
    expect(response.status).toBe(200)

    const receipt = Receipt.fromResponse(response)
    expect(receipt.status).toBe('success')

    httpServer.close()
  })

  test('behavior: context overrides account at creation', async () => {
    const fetch = Fetch.from({
      methods: [
        Methods_client.tempo({
          account: accounts[0],
          chainId: chain.id,
          rpcUrl,
        }),
      ],
    })

    const httpServer = await Http.createServer(async (req, res) => {
      const result = await toNodeListener(
        server.charge({
          request: {
            amount: '1000000',
            currency: asset,
            expires: new Date(Date.now() + 60_000).toISOString(),
            recipient: accounts[0].address,
          },
        }),
      )(req, res)
      if (result.status === 402) return
      res.end('OK')
    })

    const response = await fetch(httpServer.url, {
      context: { account: accounts[1] },
    })
    expect(response.status).toBe(200)

    httpServer.close()
  })

  test('behavior: throws when no account provided', async () => {
    const fetch = Fetch.from({
      methods: [
        Methods_client.tempo({
          chainId: chain.id,
          rpcUrl,
        }),
      ],
    })

    const httpServer = await Http.createServer(async (req, res) => {
      const result = await toNodeListener(
        server.charge({
          request: {
            amount: '1000000',
            currency: asset,
            expires: new Date(Date.now() + 60_000).toISOString(),
            recipient: accounts[0].address,
          },
        }),
      )(req, res)
      if (result.status === 402) return
      res.end('OK')
    })

    await expect(fetch(httpServer.url)).rejects.toThrow(
      'No `account` provided. Pass `account` to parameters or context.',
    )

    httpServer.close()
  })

  test('behavior: passes through non-402 responses', async () => {
    const fetch = Fetch.from({
      methods: [
        Methods_client.tempo({
          account: accounts[1],
          chainId: chain.id,
          rpcUrl,
        }),
      ],
    })

    const httpServer = await Http.createServer(async (_req, res) => {
      res.writeHead(200)
      res.end('OK')
    })

    const response = await fetch(httpServer.url)
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('OK')

    httpServer.close()
  })

  test('behavior: fee payer', async () => {
    const serverWithFeePayer = Mpay_server.create({
      method: Methods_server.tempo({
        chainId: chain.id,
        feePayer: accounts[0],
        rpcUrl,
      }),
      realm,
      secretKey,
    })

    const fetch = Fetch.from({
      methods: [
        Methods_client.tempo({
          account: accounts[1],
          chainId: chain.id,
          rpcUrl,
        }),
      ],
    })

    const httpServer = await Http.createServer(async (req, res) => {
      const result = await toNodeListener(
        serverWithFeePayer.charge({
          feePayer: accounts[0],
          request: {
            amount: '1000000',
            currency: asset,
            expires: new Date(Date.now() + 60_000).toISOString(),
            recipient: accounts[0].address,
          },
        }),
      )(req, res)
      if (result.status === 402) return
      res.end('OK')
    })

    const response = await fetch(httpServer.url)
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
})

describe('Fetch.polyfill', () => {
  test('default', async () => {
    Fetch.polyfill({
      methods: [
        Methods_client.tempo({
          account: accounts[1],
          chainId: chain.id,
          rpcUrl,
        }),
      ],
    })

    const httpServer = await Http.createServer(async (req, res) => {
      const result = await toNodeListener(
        server.charge({
          request: {
            amount: '1000000',
            currency: asset,
            expires: new Date(Date.now() + 60_000).toISOString(),
            recipient: accounts[0].address,
          },
        }),
      )(req, res)
      if (result.status === 402) return
      res.end('OK')
    })

    const response = await fetch(httpServer.url)
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
    Fetch.restore()
  })
})
