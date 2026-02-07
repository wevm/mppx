import { describe, expect, test } from 'vitest'
import * as Http from '~test/Http.js'
import { accounts, asset, client } from '~test/tempo/viem.js'
import * as Receipt from '../Receipt.js'
import * as Mpay_server from '../server/Mpay.js'
import { toNodeListener } from '../server/Mpay.js'
import { charge as charge_client } from '../tempo/client/Charge.js'
import { charge as charge_server } from '../tempo/server/Charge.js'
import * as Fetch from './Fetch.js'

const realm = 'api.example.com'
const secretKey = 'test-secret-key'

const server = Mpay_server.create({
  methods: [
    charge_server({
      client: () => client,
    }),
  ],
  realm,
  secretKey,
})

describe('Fetch.from', () => {
  test('default: account at creation', async () => {
    const fetch = Fetch.from({
      methods: [
        charge_client({
          account: accounts[1],
          client: () => client,
        }),
      ],
    })

    const httpServer = await Http.createServer(async (req, res) => {
      const result = await toNodeListener(
        server.charge({
          amount: '1',
          currency: asset,
          expires: new Date(Date.now() + 60_000).toISOString(),
          recipient: accounts[0].address,
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
        charge_client({
          client: () => client,
        }),
      ],
    })

    const httpServer = await Http.createServer(async (req, res) => {
      const result = await toNodeListener(
        server.charge({
          amount: '1',
          currency: asset,
          expires: new Date(Date.now() + 60_000).toISOString(),
          recipient: accounts[0].address,
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
        charge_client({
          account: accounts[0],
          client: () => client,
        }),
      ],
    })

    const httpServer = await Http.createServer(async (req, res) => {
      const result = await toNodeListener(
        server.charge({
          amount: '1',
          currency: asset,
          expires: new Date(Date.now() + 60_000).toISOString(),
          recipient: accounts[0].address,
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
        charge_client({
          client: () => client,
        }),
      ],
    })

    const httpServer = await Http.createServer(async (req, res) => {
      const result = await toNodeListener(
        server.charge({
          amount: '1',
          currency: asset,
          expires: new Date(Date.now() + 60_000).toISOString(),
          recipient: accounts[0].address,
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
        charge_client({
          account: accounts[1],
          client: () => client,
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
      methods: [
        charge_server({
          feePayer: accounts[0],
          client: () => client,
        }),
      ],
      realm,
      secretKey,
    })

    const fetch = Fetch.from({
      methods: [
        charge_client({
          account: accounts[1],
          client: () => client,
        }),
      ],
    })

    const httpServer = await Http.createServer(async (req, res) => {
      const result = await toNodeListener(
        serverWithFeePayer.charge({
          amount: '1',
          currency: asset,
          expires: new Date(Date.now() + 60_000).toISOString(),
          recipient: accounts[0].address,
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
        charge_client({
          account: accounts[1],
          client: () => client,
        }),
      ],
    })

    const httpServer = await Http.createServer(async (req, res) => {
      const result = await toNodeListener(
        server.charge({
          amount: '1',
          currency: asset,
          expires: new Date(Date.now() + 60_000).toISOString(),
          recipient: accounts[0].address,
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
