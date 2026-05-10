import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'

import { decodeFunctionData, erc20Abi, parseUnits, type Address } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { Addresses, Transaction } from 'viem/tempo'
import { afterAll, describe, expect, test } from 'vp/test'
import * as Http from '~test/Http.js'
import { rpcUrl } from '~test/tempo/prool.js'
import { deployEscrow, escrowAbi } from '~test/tempo/session.js'
import { accounts, asset, chain, client, fundAccount } from '~test/tempo/viem.js'

import * as Challenge from '../Challenge.js'
import * as Credential from '../Credential.js'
import * as Method from '../Method.js'
import * as Receipt from '../Receipt.js'
import * as Mppx_server from '../server/Mppx.js'
import { toNodeListener } from '../server/Mppx.js'
import * as Store from '../Store.js'
import { stripe as stripe_server } from '../stripe/server/Methods.js'
import { tempo } from '../tempo/server/Methods.js'
import type { SessionCredentialPayload } from '../tempo/session/Types.js'
import * as z from '../zod.js'
import cli from './cli.js'

const testPrivateKey = generatePrivateKey()
const testAccount = privateKeyToAccount(testPrivateKey)
const cliTestXdgDataHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mppx-cli-xdg-'))
const cliSessionFeePayerPolicy = {
  maxGas: 2_250_000n,
  maxTotalFee: 60_000_000_000_000_000n,
}

afterAll(() => {
  fs.rmSync(cliTestXdgDataHome, { recursive: true, force: true })
})

async function serve(argv: string[], options?: { env?: Record<string, string | undefined> }) {
  let output = ''
  let stderr = ''
  let exitCode: number | undefined
  const saved: Record<string, string | undefined> = {}
  const env = { XDG_DATA_HOME: cliTestXdgDataHome, ...options?.env }
  for (const [key, value] of Object.entries(env)) {
    saved[key] = process.env[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  const origStdoutWrite = process.stdout.write
  const origStderrWrite = process.stderr.write
  const origLog = console.log
  const origError = console.error
  process.stdout.write = ((chunk: unknown) => {
    output += typeof chunk === 'string' ? chunk : String(chunk)
    return true
  }) as typeof process.stdout.write
  process.stderr.write = ((chunk: unknown) => {
    stderr += typeof chunk === 'string' ? chunk : String(chunk)
    return true
  }) as typeof process.stderr.write
  console.log = (...args: unknown[]) => {
    output += `${args.map(String).join(' ')}\n`
  }
  console.error = (...args: unknown[]) => {
    stderr += `${args.map(String).join(' ')}\n`
  }
  try {
    await cli.serve(argv, {
      stdout(s: string) {
        output += s
      },
      exit(code: number) {
        exitCode = code
      },
    })
  } finally {
    process.stdout.write = origStdoutWrite
    process.stderr.write = origStderrWrite
    console.log = origLog
    console.error = origError
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
  return { output, stderr, exitCode }
}

function createMockChargeMethod(name: string) {
  return Method.from({
    name,
    intent: 'charge',
    schema: {
      credential: {
        payload: z.object({ token: z.string() }),
      },
      request: z.object({
        amount: z.string(),
        currency: z.string(),
        decimals: z.number(),
        recipient: z.string(),
      }),
    },
  })
}

describe('discover validate', () => {
  test('validates a local discovery document', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mppx-discovery-'))
    const file = path.join(dir, 'openapi.json')
    fs.writeFileSync(
      file,
      JSON.stringify({
        info: { title: 'Test', version: '1.0.0' },
        openapi: '3.1.0',
        paths: {
          '/search': {
            post: {
              'x-payment-info': {
                amount: '100',
                intent: 'charge',
                method: 'tempo',
              },
              requestBody: {
                content: { 'application/json': { schema: { type: 'object' } } },
              },
              responses: {
                '200': { description: 'OK' },
                '402': { description: 'Payment Required' },
              },
            },
          },
        },
      }),
    )

    const { output, exitCode } = await serve(['discover', 'validate', file])
    expect(exitCode).toBeUndefined()
    expect(output).toContain('Discovery document is valid.')
  })

  test('returns non-zero for invalid discovery documents', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mppx-discovery-'))
    const file = path.join(dir, 'openapi.json')
    fs.writeFileSync(
      file,
      JSON.stringify({
        info: { title: 'Test', version: '1.0.0' },
        openapi: '3.1.0',
        paths: {
          '/search': {
            post: {
              'x-payment-info': {
                amount: '100',
                intent: 'charge',
                method: 'tempo',
              },
              responses: {
                '200': { description: 'OK' },
              },
            },
          },
        },
      }),
    )

    const { output, exitCode } = await serve(['discover', 'validate', file])
    expect(exitCode).toBe(1)
    expect(output).toContain('[error]')
    expect(output).toContain('402')
  })

  test(
    'validates remote discovery documents and reports warnings',
    { timeout: 20_000 },
    async () => {
      const body = JSON.stringify({
        info: { title: 'Test', version: '1.0.0' },
        openapi: '3.1.0',
        paths: {
          '/search': {
            post: {
              'x-payment-info': {
                amount: '100',
                intent: 'charge',
                method: 'tempo',
              },
              responses: {
                '200': { description: 'OK' },
                '402': { description: 'Payment Required' },
              },
            },
          },
        },
      })
      const server = await Http.createServer((_req, res) => {
        res.setHeader('Content-Type', 'application/json')
        res.end(body)
      })

      try {
        const { output, exitCode } = await serve(['discover', 'validate', server.url])
        expect(exitCode).toBeUndefined()
        expect(output).toContain('[warning]')
        expect(output).toContain('requestBody')
        expect(output).toContain('valid with 1 warning')
      } finally {
        server.close()
      }
    },
  )

  test(
    'rejects oversized discovery documents via content-length',
    { timeout: 20_000 },
    async () => {
      const server = await Http.createServer((_req, res) => {
        res.setHeader('Content-Type', 'application/json')
        res.setHeader('Content-Length', String(11 * 1024 * 1024))
        res.end('{}')
      })

      try {
        const { exitCode, output } = await serve(['discover', 'validate', server.url])
        expect(exitCode).toBe(1)
        expect(output).toContain('10 MB')
      } finally {
        server.close()
      }
    },
  )
})

describe('discover generate', () => {
  test('generates from a pre-built OpenAPI document module', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mppx-generate-'))
    const mod = path.join(dir, 'doc.mjs')
    fs.writeFileSync(
      mod,
      `export default ${JSON.stringify({
        openapi: '3.1.0',
        info: { title: 'Test', version: '1.0.0' },
        paths: {
          '/pay': {
            post: {
              'x-payment-info': { amount: '100', intent: 'charge', method: 'tempo' },
              responses: {
                '200': { description: 'OK' },
                '402': { description: 'Payment Required' },
              },
            },
          },
        },
      })}`,
    )

    const { output, exitCode } = await serve(['discover', 'generate', mod])
    expect(exitCode).toBeUndefined()
    const doc = JSON.parse(output)
    expect(doc.openapi).toBe('3.1.0')
    expect(doc.paths['/pay'].post['x-payment-info'].amount).toBe('100')

    fs.rmSync(dir, { recursive: true, force: true })
  })

  test('writes to file with --output', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mppx-generate-'))
    const mod = path.join(dir, 'doc.mjs')
    const outFile = path.join(dir, 'openapi.json')
    fs.writeFileSync(
      mod,
      `export default ${JSON.stringify({
        openapi: '3.1.0',
        info: { title: 'Test', version: '1.0.0' },
        paths: {},
      })}`,
    )

    const { output, stderr, exitCode } = await serve([
      'discover',
      'generate',
      mod,
      '--output',
      outFile,
    ])
    expect(exitCode).toBeUndefined()
    expect(output).toBe('')
    expect(stderr).toContain(outFile)
    const written = JSON.parse(fs.readFileSync(outFile, 'utf-8'))
    expect(written.openapi).toBe('3.1.0')

    fs.rmSync(dir, { recursive: true, force: true })
  })

  test('errors when module not found', async () => {
    const { output, exitCode } = await serve([
      'discover',
      'generate',
      '/tmp/nonexistent-mppx-module.mjs',
    ])
    expect(exitCode).toBe(1)
    expect(output).toContain('MODULE_NOT_FOUND')
  })

  test('errors when module has no mppx or openapi export', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mppx-generate-'))
    const mod = path.join(dir, 'bad.mjs')
    fs.writeFileSync(mod, 'export default { foo: "bar" }')

    const { output, exitCode } = await serve(['discover', 'generate', mod])
    expect(exitCode).toBe(1)
    expect(output).toContain('INVALID_MODULE')

    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe('services', () => {
  const registry = {
    version: 1,
    services: [
      {
        id: 'fal',
        name: 'fal',
        serviceUrl: 'https://fal.mpp.dev',
        description: 'Image generation',
        tags: ['image'],
        status: 'active',
        docs: { homepage: 'https://docs.fal.ai' },
        endpoints: [
          {
            method: 'POST',
            path: '/fal-ai/fast-sdxl',
            description: 'Generate an image',
            payment: {
              amount: '3000',
              currency: '0x20c000000000000000000000b9537d11c60e8b50',
              decimals: 6,
              intent: 'charge',
              method: 'tempo',
            },
          },
          {
            method: 'GET',
            path: '/health',
            description: 'Health check',
            payment: null,
          },
        ],
      },
      {
        id: 'freebie',
        name: 'Freebie',
        serviceUrl: 'https://freebie.example',
        endpoints: [],
      },
    ],
  }

  async function withRegistry<T>(fn: (url: string) => Promise<T>) {
    const server = await Http.createServer((_req, res) => {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify(registry))
    })
    try {
      return await fn(server.url)
    } finally {
      server.close()
    }
  }

  test('list: prints registered services', async () => {
    await withRegistry(async (url) => {
      const { output, exitCode } = await serve(['services', 'list'], {
        env: { MPPX_SERVICES_URL: url },
      })

      expect(exitCode).toBeUndefined()
      expect(output).toContain('fal')
      expect(output).toContain('1 paid')
      expect(output).toContain('https://fal.mpp.dev')
    })
  })

  test('list: supports structured output and filtering', async () => {
    await withRegistry(async (url) => {
      const { output, exitCode } = await serve(['services', 'list', '--query', 'image', '--json'], {
        env: { MPPX_SERVICES_URL: url },
      })

      expect(exitCode).toBeUndefined()
      const parsed = JSON.parse(output)
      expect(parsed.services).toHaveLength(1)
      expect(parsed.services[0]).toMatchObject({ id: 'fal', paidEndpoints: 1 })
    })
  })

  test('show: prints service metadata', async () => {
    await withRegistry(async (url) => {
      const { output, exitCode } = await serve(['services', 'show', 'fal'], {
        env: { MPPX_SERVICES_URL: url },
      })

      expect(exitCode).toBeUndefined()
      expect(output).toContain('Image generation')
      expect(output).toContain('https://docs.fal.ai')
      expect(output).toContain('2 (1 paid)')
    })
  })

  test('endpoints: prints paid endpoint details', async () => {
    await withRegistry(async (url) => {
      const { output, exitCode } = await serve(['services', 'endpoints', 'fal'], {
        env: { MPPX_SERVICES_URL: url },
      })

      expect(exitCode).toBeUndefined()
      expect(output).toContain('POST')
      expect(output).toContain('/fal-ai/fast-sdxl')
      expect(output).toContain('3000')
      expect(output).toContain('tempo/charge')
    })
  })
})

describe('basic charge (examples/basic)', () => {
  test('happy path: makes payment and receives response', { timeout: 120_000 }, async () => {
    const { Actions } = await import('viem/tempo')
    await Actions.token.transferSync(client, {
      account: accounts[0],
      chain: client.chain,
      token: asset,
      to: testAccount.address,
      amount: parseUnits('100', 6),
    })

    const server = Mppx_server.create({
      methods: [tempo.charge({ getClient: () => client })],
      realm: 'cli-test-basic',
      secretKey: 'cli-test-secret',
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
      res.end('paid')
    })

    try {
      const { output } = await serve([httpServer.url, '--rpc-url', rpcUrl, '-s'], {
        env: { MPPX_PRIVATE_KEY: testPrivateKey },
      })
      expect(output).toContain('paid')
    } finally {
      httpServer.close()
    }
  })

  test('selects a later supported challenge when the first offer is unsupported', async () => {
    const unsupportedMethod = Method.toServer(createMockChargeMethod('unknown'), {
      async verify() {
        return {
          method: 'unknown',
          reference: 'unknown-ref',
          status: 'success' as const,
          timestamp: new Date().toISOString(),
        }
      },
    })
    const tempoMethod = tempo.charge({ getClient: () => client })

    const server = Mppx_server.create({
      methods: [unsupportedMethod, tempoMethod],
      realm: 'cli-test-multi-offer',
      secretKey: 'cli-test-secret',
    })

    const httpServer = await Http.createServer(async (req, res) => {
      const result = await toNodeListener(
        server.compose(
          [
            unsupportedMethod,
            {
              amount: '1',
              currency: asset,
              decimals: 6,
              expires: new Date(Date.now() + 60_000).toISOString(),
              recipient: accounts[0].address,
            },
          ],
          [
            tempoMethod,
            {
              amount: '1',
              currency: asset,
              decimals: 6,
              expires: new Date(Date.now() + 60_000).toISOString(),
              recipient: accounts[0].address,
            },
          ],
        ),
      )(req, res)
      if (result.status === 402) return
      res.end('paid-from-second-offer')
    })

    try {
      const { output, exitCode } = await serve([httpServer.url, '--rpc-url', rpcUrl, '-s'], {
        env: { MPPX_PRIVATE_KEY: testPrivateKey },
      })

      expect(exitCode).toBeUndefined()
      expect(output).toContain('paid-from-second-offer')
    } finally {
      httpServer.close()
    }
  })

  test('config methods emit Accept-Payment and select the preferred challenge', async () => {
    const alphaMethod = Method.toServer(createMockChargeMethod('alpha'), {
      async verify({ envelope }) {
        if (!envelope) throw new Error('expected envelope')
        if ((envelope.credential.payload as { token: string }).token !== 'alpha-token') {
          throw new Error('expected alpha credential')
        }

        return {
          method: 'alpha',
          reference: 'alpha-ref',
          status: 'success' as const,
          timestamp: new Date().toISOString(),
        }
      },
    })
    const betaMethod = Method.toServer(createMockChargeMethod('beta'), {
      async verify({ envelope }) {
        if (!envelope) throw new Error('expected envelope')
        if ((envelope.credential.payload as { token: string }).token !== 'beta-token') {
          throw new Error('expected beta credential')
        }

        return {
          method: 'beta',
          reference: 'beta-ref',
          status: 'success' as const,
          timestamp: new Date().toISOString(),
        }
      },
    })

    const server = Mppx_server.create({
      methods: [betaMethod, alphaMethod],
      realm: 'cli-test-config-offers',
      secretKey: 'cli-test-secret',
    })

    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mppx-cli-config-'))
    const configPath = path.join(configDir, 'mppx.config.mjs')
    const mppxModuleUrl = pathToFileURL(path.join(process.cwd(), 'src/index.ts')).href
    const cliModuleUrl = pathToFileURL(path.join(process.cwd(), 'src/cli/config.ts')).href
    fs.writeFileSync(
      configPath,
      `
import { Credential, Method, z } from '${mppxModuleUrl}'
import { defineConfig } from '${cliModuleUrl}'

const alpha = Method.toClient(Method.from({
  name: 'alpha',
  intent: 'charge',
  schema: {
    credential: { payload: z.object({ token: z.string() }) },
    request: z.object({ amount: z.string(), currency: z.string(), decimals: z.number(), recipient: z.string() }),
  },
}), {
  async createCredential({ challenge }) {
    return Credential.serialize({ challenge, payload: { token: 'alpha-token' } })
  },
})

const beta = Method.toClient(Method.from({
  name: 'beta',
  intent: 'charge',
  schema: {
    credential: { payload: z.object({ token: z.string() }) },
    request: z.object({ amount: z.string(), currency: z.string(), decimals: z.number(), recipient: z.string() }),
  },
}), {
  async createCredential({ challenge }) {
    return Credential.serialize({ challenge, payload: { token: 'beta-token' } })
  },
})

export default defineConfig({
  methods: [beta, alpha],
  paymentPreferences: ({ alpha, beta }) => ({
    [alpha.charge]: 1,
    [beta.charge]: 0.2,
  }),
})
      `.trim(),
    )

    let acceptPaymentHeader: string | undefined
    let authorization: string | undefined
    const httpServer = await Http.createServer(async (req, res) => {
      if (!req.headers.authorization)
        acceptPaymentHeader = req.headers['accept-payment'] as string | undefined
      else authorization = req.headers.authorization

      const result = await toNodeListener(
        server.compose(
          [
            betaMethod,
            {
              amount: '1',
              currency: asset,
              decimals: 6,
              expires: new Date(Date.now() + 60_000).toISOString(),
              recipient: accounts[0].address,
            },
          ],
          [
            alphaMethod,
            {
              amount: '1',
              currency: asset,
              decimals: 6,
              expires: new Date(Date.now() + 60_000).toISOString(),
              recipient: accounts[0].address,
            },
          ],
        ),
      )(req, res)
      if (result.status === 402) return
      res.end('paid-from-config-preference')
    })

    try {
      const { output, exitCode } = await serve([httpServer.url, '--config', configPath, '-s'])

      expect(exitCode).toBeUndefined()
      expect(output).toContain('paid-from-config-preference')
      expect(acceptPaymentHeader).toBe('beta/charge;q=0.2, alpha/charge')
      expect(Credential.deserialize(authorization!).payload).toEqual({ token: 'alpha-token' })
    } finally {
      httpServer.close()
      fs.rmSync(configDir, { recursive: true, force: true })
    }
  })

  test(
    'zero-amount charge uses a proof credential and receives response',
    { timeout: 120_000 },
    async () => {
      const server = Mppx_server.create({
        methods: [tempo.charge({ getClient: () => client })],
        realm: 'localhost',
        secretKey: 'cli-test-secret',
      })
      let authorization: string | undefined

      const httpServer = await Http.createServer(async (req, res) => {
        authorization = req.headers.authorization
        const result = await toNodeListener(
          server.charge({
            amount: '0',
            currency: asset,
            expires: new Date(Date.now() + 60_000).toISOString(),
            recipient: accounts[0].address,
          }),
        )(req, res)
        if (result.status === 402) return
        res.end('zero-dollar-paid')
      })

      try {
        const { output, exitCode } = await serve([httpServer.url, '--rpc-url', rpcUrl, '-s'], {
          env: { MPPX_PRIVATE_KEY: testPrivateKey },
        })
        expect(exitCode).toBeUndefined()
        expect(output).toContain('zero-dollar-paid')

        const credential = Credential.deserialize<{ signature: string; type: 'proof' }>(
          authorization!,
        )
        expect(credential.challenge.request.amount).toBe('0')
        expect(credential.payload.type).toBe('proof')
        expect(credential.payload.signature).toMatch(/^0x/)
        expect(credential.source).toBe(`did:pkh:eip155:${chain.id}:${testAccount.address}`)
      } finally {
        httpServer.close()
      }
    },
  )

  test(
    'zero-amount charge with testnet currency omission uses a proof credential',
    { timeout: 120_000 },
    async () => {
      const isTestnet = true
      const mainnetCurrency = '0x20C00000000000000000000b9537d11c60E8b50' as `0x${string}`

      const server = Mppx_server.create({
        methods: [
          tempo.charge({
            getClient: () => client,
            ...(isTestnet ? {} : { currency: mainnetCurrency }),
            testnet: isTestnet,
          }),
        ],
        realm: 'localhost',
        secretKey: 'cli-test-secret',
      })
      let authorization: string | undefined

      const httpServer = await Http.createServer(async (req, res) => {
        authorization = req.headers.authorization
        const result = await toNodeListener(
          server.charge({
            amount: '0',
            chainId: chain.id,
            expires: new Date(Date.now() + 60_000).toISOString(),
            recipient: accounts[0].address,
          }),
        )(req, res)
        if (result.status === 402) return
        res.end('zero-dollar-testnet-paid')
      })

      try {
        const { output, exitCode } = await serve([httpServer.url, '--rpc-url', rpcUrl, '-s'], {
          env: { MPPX_PRIVATE_KEY: testPrivateKey },
        })
        expect(exitCode).toBeUndefined()
        expect(output).toContain('zero-dollar-testnet-paid')

        const credential = Credential.deserialize<{ signature: string; type: 'proof' }>(
          authorization!,
        )
        expect(credential.challenge.request.amount).toBe('0')
        expect(credential.challenge.request.currency).toBe(
          '0x20c0000000000000000000000000000000000000',
        )
        expect(credential.payload.type).toBe('proof')
        expect(credential.source).toBe(`did:pkh:eip155:${chain.id}:${testAccount.address}`)
      } finally {
        httpServer.close()
      }
    },
  )

  test('error: no account found', { timeout: 60_000 }, async () => {
    const server = Mppx_server.create({
      methods: [tempo.charge({ getClient: () => client })],
      realm: 'cli-test-no-account',
      secretKey: 'cli-test-secret',
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
      res.end('paid')
    })

    try {
      const { output, exitCode } = await serve(
        [httpServer.url, '--account', 'nonexistent-account'],
        { env: { MPPX_PRIVATE_KEY: undefined } },
      )
      expect(exitCode).toBe(69)
      expect(output).toContain('nonexistent-account')
      expect(output).toContain('not found')
    } finally {
      httpServer.close()
    }
  })
})

describe('session multi-fetch (examples/session/multi-fetch)', () => {
  test('happy path: stream payment and receives response', { timeout: 120_000 }, async () => {
    await fundAccount({ address: testAccount.address, token: Addresses.pathUsd })
    await fundAccount({ address: testAccount.address, token: asset })

    const escrow = await deployEscrow()
    const store = Store.memory()
    const server = Mppx_server.create({
      methods: [
        tempo.session({
          account: accounts[0],
          store,
          getClient: () => client,
          currency: asset,
          escrowContract: escrow,
          chainId: client.chain.id,
          feePayer: true,
          feePayerPolicy: cliSessionFeePayerPolicy,
        }),
      ],
      realm: 'cli-test-multifetch',
      secretKey: 'cli-test-secret',
    })

    const httpServer = await Http.createServer(async (req, res) => {
      const result = await toNodeListener(
        server.session({
          amount: '0.001',
          recipient: accounts[0].address,
          unitType: 'page',
        }),
      )(req, res)
      if (result.status === 402) return
      res.end('scraped-content')
    })

    try {
      const { output } = await serve(
        [httpServer.url, '--rpc-url', rpcUrl, '-s', '-M', 'deposit=10'],
        { env: { MPPX_PRIVATE_KEY: testPrivateKey } },
      )
      expect(output).toContain('scraped-content')
    } finally {
      httpServer.close()
    }
  })

  test('prefers CLI deposit over server suggestedDeposit', { timeout: 120_000 }, async () => {
    await fundAccount({ address: testAccount.address, token: Addresses.pathUsd })
    await fundAccount({ address: testAccount.address, token: asset })

    const escrow = await deployEscrow()
    let openCredential: SessionCredentialPayload | undefined

    const httpServer = await Http.createServer(async (req, res) => {
      const authHeader = req.headers.authorization
      if (!authHeader) {
        res.writeHead(402, {
          'WWW-Authenticate': Challenge.serialize(
            Challenge.from({
              id: 'cli-deposit-override',
              realm: 'cli-test-deposit-override',
              method: 'tempo',
              intent: 'session',
              request: {
                amount: '1000000',
                currency: asset,
                decimals: 6,
                recipient: accounts[0].address,
                suggestedDeposit: '7000000',
                unitType: 'token',
                methodDetails: {
                  chainId: chain.id,
                  escrowContract: escrow,
                },
              },
            }),
          ),
        })
        res.end()
        return
      }

      try {
        const cred = Credential.deserialize<SessionCredentialPayload>(authHeader)
        if (cred.payload.action === 'open') openCredential = cred.payload
      } catch {}

      res.writeHead(200)
      res.end('scraped-content')
    })

    try {
      await serve([httpServer.url, '--rpc-url', rpcUrl, '-s', '-M', 'deposit=10'], {
        env: { MPPX_PRIVATE_KEY: testPrivateKey },
      })

      expect(openCredential).toBeDefined()
      expect(openCredential?.action).toBe('open')
      if (!openCredential || openCredential.action !== 'open')
        throw new Error('missing open credential')

      const transaction = Transaction.deserialize(openCredential.transaction)
      if (!('calls' in transaction)) throw new Error('unexpected transaction type')
      const [approveCall, openCall] = transaction.calls as readonly [
        { to?: Address; data?: `0x${string}` },
        { to?: Address; data?: `0x${string}` },
      ]
      const approve = decodeFunctionData({ abi: erc20Abi, data: approveCall.data ?? '0x' })
      const open = decodeFunctionData({ abi: escrowAbi, data: openCall.data ?? '0x' })
      const approveArgs = approve.args as readonly [Address, bigint]
      const openArgs = open.args as readonly [Address, Address, bigint, string, Address]

      expect(approveCall.to).toBe(asset)
      expect(approve.functionName).toBe('approve')
      expect(approveArgs[0].toLowerCase()).toBe(escrow.toLowerCase())
      expect(approveArgs[1]).toBe(10_000_000n)

      expect(openCall.to?.toLowerCase()).toBe(escrow.toLowerCase())
      expect(open.functionName).toBe('open')
      expect(openArgs[0].toLowerCase()).toBe(accounts[0].address.toLowerCase())
      expect(openArgs[1].toLowerCase()).toBe(asset.toLowerCase())
      expect(openArgs[2]).toBe(10_000_000n)
      expect(openArgs[3]).toEqual(expect.any(String))
      expect(openArgs[4].toLowerCase()).toBe(testAccount.address.toLowerCase())
    } finally {
      httpServer.close()
    }
  })

  test('bug: non-SSE open should not double-charge tick amount', { timeout: 120_000 }, async () => {
    await fundAccount({ address: testAccount.address, token: Addresses.pathUsd })
    await fundAccount({ address: testAccount.address, token: asset })

    const escrow = await deployEscrow()
    const store = Store.memory()
    const tickAmount = '0.001'
    const server = Mppx_server.create({
      methods: [
        tempo.session({
          account: accounts[0],
          store,
          getClient: () => client,
          currency: asset,
          escrowContract: escrow,
          chainId: client.chain.id,
          feePayer: true,
          feePayerPolicy: cliSessionFeePayerPolicy,
        }),
      ],
      realm: 'cli-test-double-charge',
      secretKey: 'cli-test-secret',
    })

    // Track voucher cumulative amounts from credential payloads
    const voucherAmounts: string[] = []

    const httpServer = await Http.createServer(async (req, res) => {
      const authHeader = req.headers.authorization
      if (authHeader) {
        try {
          const cred = Credential.deserialize<SessionCredentialPayload>(authHeader)
          if (cred.payload.action === 'voucher' && 'cumulativeAmount' in cred.payload) {
            voucherAmounts.push(cred.payload.cumulativeAmount)
          }
        } catch {}
      }

      const result = await toNodeListener(
        server.session({
          amount: tickAmount,
          recipient: accounts[0].address,
          unitType: 'page',
        }),
      )(req, res)
      if (result.status === 402) return
      // Non-SSE: plain text response (not text/event-stream)
      res.end('scraped-content')
    })

    try {
      await serve([httpServer.url, '--rpc-url', rpcUrl, '-s', '-M', 'deposit=10'], {
        env: { MPPX_PRIVATE_KEY: testPrivateKey },
      })

      // No follow-up voucher should be sent after a non-SSE open.
      // The open credential already paid for this unit, so the CLI
      // should NOT send a redundant voucher that would double-charge.
      expect(voucherAmounts.length).toBe(0)
    } finally {
      httpServer.close()
    }
  })

  test('bug: closeChannel sends action "close" not "voucher"', { timeout: 120_000 }, async () => {
    await fundAccount({ address: testAccount.address, token: Addresses.pathUsd })
    await fundAccount({ address: testAccount.address, token: asset })

    const escrow = await deployEscrow()
    const store = Store.memory()
    const server = Mppx_server.create({
      methods: [
        tempo.session({
          account: accounts[0],
          store,
          getClient: () => client,
          currency: asset,
          escrowContract: escrow,
          chainId: client.chain.id,
          feePayer: true,
          feePayerPolicy: cliSessionFeePayerPolicy,
        }),
      ],
      realm: 'cli-test-close-action',
      secretKey: 'cli-test-secret',
    })

    // Track the credential payload action from the close request
    const credentialActions: string[] = []

    const httpServer = await Http.createServer(async (req, res) => {
      // Capture credential action from every request with Authorization header
      const authHeader = req.headers.authorization
      if (authHeader) {
        try {
          const cred = Credential.deserialize<SessionCredentialPayload>(authHeader)
          credentialActions.push(cred.payload.action)
        } catch {}
      }

      const result = await toNodeListener(
        server.session({
          amount: '0.001',
          recipient: accounts[0].address,
          unitType: 'page',
        }),
      )(req, res)
      if (result.status === 402) return
      res.end('scraped-content')
    })

    try {
      await serve([httpServer.url, '--rpc-url', rpcUrl, '-s', '-M', 'deposit=10'], {
        env: { MPPX_PRIVATE_KEY: testPrivateKey },
      })

      // The last credential sent should be the close request with action: 'close'
      const lastAction = credentialActions[credentialActions.length - 1]
      expect(lastAction).toBe('close')
    } finally {
      httpServer.close()
    }
  })

  test('error: --fail exits on server error', { timeout: 60_000 }, async () => {
    const httpServer = await Http.createServer(async (_req, res) => {
      res.writeHead(500)
      res.end('Internal Server Error')
    })

    try {
      const { exitCode } = await serve([httpServer.url, '--rpc-url', rpcUrl, '--fail'], {
        env: { MPPX_PRIVATE_KEY: testPrivateKey },
      })
      expect(exitCode).toBe(22)
    } finally {
      httpServer.close()
    }
  })
})

describe('session sse (examples/session/sse)', () => {
  test('streams SSE tokens to stdout', { timeout: 120_000 }, async () => {
    await fundAccount({ address: testAccount.address, token: Addresses.pathUsd })
    await fundAccount({ address: testAccount.address, token: asset })

    const escrow = await deployEscrow()
    const store = Store.memory()
    const server = Mppx_server.create({
      methods: [
        tempo.session({
          account: accounts[0],
          store,
          getClient: () => client,
          currency: asset,
          escrowContract: escrow,
          chainId: client.chain.id,
          feePayer: true,
          feePayerPolicy: cliSessionFeePayerPolicy,
        }),
      ],
      realm: 'cli-test-sse',
      secretKey: 'cli-test-secret',
    })

    const httpServer = await Http.createServer(async (req, res) => {
      const result = await toNodeListener(
        server.session({
          amount: '0.001',
          recipient: accounts[0].address,
          unitType: 'token',
        }),
      )(req, res)
      if (result.status === 402) return

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      })
      const tokens = ['Hello', ' world', '!']
      for (const token of tokens) {
        res.write(`data: ${JSON.stringify({ token })}\n\n`)
      }
      res.write('data: [DONE]\n\n')
      res.end()
    })

    try {
      const { output } = await serve([httpServer.url, '--rpc-url', rpcUrl, '-M', 'deposit=10'], {
        env: { MPPX_PRIVATE_KEY: testPrivateKey },
      })
      expect(output.trim()).toBe('Hello world!')
    } finally {
      httpServer.close()
    }
  })

  test('error: server 500 with --fail exits non-zero', { timeout: 60_000 }, async () => {
    const httpServer = await Http.createServer(async (_req, res) => {
      res.writeHead(500)
      res.end('Internal Server Error')
    })
    try {
      const { exitCode } = await serve([httpServer.url, '--rpc-url', rpcUrl, '--fail'], {
        env: { MPPX_PRIVATE_KEY: testPrivateKey },
      })
      expect(exitCode).toBe(22)
    } finally {
      httpServer.close()
    }
  })
})

describe('stripe charge', () => {
  test('happy path: makes Stripe payment and receives response', { timeout: 60_000 }, async () => {
    const mockStripeClient = {
      paymentIntents: { create: async () => ({ id: 'pi_mock_cli_123', status: 'succeeded' }) },
    }

    const server = Mppx_server.create({
      methods: [
        stripe_server.charge({
          client: mockStripeClient,
          networkId: 'internal',
          paymentMethodTypes: ['card'],
        }),
      ],
      realm: 'cli-test-stripe',
      secretKey: 'cli-test-secret',
    })

    const sptServer = await Http.createServer(async (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ id: 'spt_mock_cli_test' }))
    })

    const appServer = await Http.createServer(async (req, res) => {
      const result = await Mppx_server.toNodeListener(
        server.charge({ amount: '1', currency: 'usd', decimals: 2 }),
      )(req, res)
      if (result.status === 402) return
      res.end('paid')
    })

    try {
      const { output } = await serve([appServer.url, '-s', '-M', 'paymentMethod=pm_card_visa'], {
        env: {
          MPPX_STRIPE_SECRET_KEY: 'sk_test_mock_cli_value',
          MPPX_STRIPE_SPT_URL: sptServer.url,
        },
      })
      expect(output).toContain('paid')
    } finally {
      appServer.close()
      sptServer.close()
    }
  })

  test('error: missing MPPX_STRIPE_SECRET_KEY', { timeout: 60_000 }, async () => {
    const server = Mppx_server.create({
      methods: [
        stripe_server.charge({
          secretKey: 'sk_test_mock',
          networkId: 'internal',
          paymentMethodTypes: ['card'],
        }),
      ],
      realm: 'cli-test-stripe-nokey',
      secretKey: 'cli-test-secret',
    })

    const appServer = await Http.createServer(async (req, res) => {
      const result = await Mppx_server.toNodeListener(
        server.charge({ amount: '1', currency: 'usd', decimals: 2 }),
      )(req, res)
      if (result.status === 402) return
      res.end('paid')
    })

    try {
      const { output, exitCode } = await serve(
        [appServer.url, '-s', '-M', 'paymentMethod=pm_card_visa'],
        { env: { MPPX_STRIPE_SECRET_KEY: '' } },
      )
      expect(exitCode).toBe(2)
      expect(output).toContain('MPPX_STRIPE_SECRET_KEY')
    } finally {
      appServer.close()
    }
  })

  test('error: production key rejected', { timeout: 60_000 }, async () => {
    const server = Mppx_server.create({
      methods: [
        stripe_server.charge({
          secretKey: 'sk_test_mock',
          networkId: 'internal',
          paymentMethodTypes: ['card'],
        }),
      ],
      realm: 'cli-test-stripe-live',
      secretKey: 'cli-test-secret',
    })

    const appServer = await Http.createServer(async (req, res) => {
      const result = await Mppx_server.toNodeListener(
        server.charge({ amount: '1', currency: 'usd', decimals: 2 }),
      )(req, res)
      if (result.status === 402) return
      res.end('paid')
    })

    try {
      const { output, exitCode } = await serve(
        [appServer.url, '-s', '-M', 'paymentMethod=pm_card_visa'],
        { env: { MPPX_STRIPE_SECRET_KEY: 'sk_live_fake' } },
      )
      expect(exitCode).toBe(2)
      expect(output).toContain('test mode')
    } finally {
      appServer.close()
    }
  })
})

// ---------------------------------------------------------------------------
// account [action]
// TODO: investigate account tests timing out in CI (secret-tool/gnome-keyring hangs)
// ---------------------------------------------------------------------------
describe.skipIf(!!process.env.CI)('account', () => {
  const binPath = path.resolve(import.meta.dirname, '../bin.ts')
  const cwd = path.resolve(import.meta.dirname, '../..')
  const accountEnv = {
    ...process.env,
    NODE_NO_WARNINGS: '1',
    XDG_DATA_HOME: cliTestXdgDataHome,
  }
  const prefix = `__mppx_test_${Date.now()}`
  const createdAccounts: string[] = []

  function accountRun(args: string[], options?: { input?: string }) {
    const result = spawnSync('node', ['--import', 'tsx', binPath, ...args], {
      encoding: 'utf8',
      cwd,
      timeout: 60_000,
      ...(options?.input !== undefined && { input: options.input }),
      env: accountEnv,
    })
    return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status }
  }

  function createAccount(name: string) {
    const result = accountRun(['account', 'create', '--account', name], { input: '' })
    if (result.status === 0) createdAccounts.push(name)
    return result
  }

  function deleteAccount(name: string) {
    return accountRun(['account', 'delete', '--account', name, '--yes'], { input: '' })
  }

  afterAll(() => {
    for (const name of createdAccounts) {
      deleteAccount(name)
    }
  })

  // --- account create ---

  test('create: creates a new account and prints address', () => {
    const name = `${prefix}_create`
    const result = createAccount(name)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain(`Account "${name}" saved to keychain.`)
    expect(result.stdout).toContain('Address 0x')
  })

  test('create: duplicate name exits with message', () => {
    const name = `${prefix}_dup`
    createAccount(name)
    const result = accountRun(['account', 'create', '--account', name], { input: '' })
    expect(result.stdout).not.toContain('saved to keychain')
  })

  // --- account view ---

  test('view: shows address for existing account', () => {
    const name = `${prefix}_view`
    createAccount(name)
    const result = accountRun(['account', 'view', '--account', name])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Address')
    expect(result.stdout).toMatch(/0x[0-9a-fA-F]{40}/)
  })

  test('view: missing account exits non-zero', () => {
    const result = accountRun(['account', 'view', '--account', `${prefix}_nonexistent`])
    expect(result.status).not.toBe(0)
    expect(result.stdout).toContain('not found')
  })

  // --- account export ---

  test('export: prints private key for existing account', () => {
    const name = `${prefix}_export`
    createAccount(name)
    const result = accountRun(['account', 'export', '--account', name])
    expect(result.status).toBe(0)

    const privateKey = result.stdout.match(/0x[0-9a-fA-F]{64}/)?.[0]
    expect(privateKey).toBeDefined()

    const view = accountRun(['account', 'view', '--account', name])
    expect(view.stdout).toContain(privateKeyToAccount(privateKey as `0x${string}`).address)
  })

  test('export: missing account exits non-zero', () => {
    const result = accountRun(['account', 'export', '--account', `${prefix}_missing_export`])
    expect(result.status).not.toBe(0)
    expect(result.stdout).toContain('not found')
  })

  // --- account list ---

  test('list: includes created accounts', () => {
    const name = `${prefix}_list`
    createAccount(name)
    const result = accountRun(['account', 'list'])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain(name)
  })

  // --- account default ---

  test('default: sets default account', () => {
    const name = `${prefix}_default`
    createAccount(name)
    const result = accountRun(['account', 'default', '--account', name])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain(`Default account set to "${name}"`)
  })

  test('default: missing --account flag exits non-zero', () => {
    const result = accountRun(['account', 'default'])
    expect(result.status).not.toBe(0)
  })

  test('default: nonexistent account exits non-zero', () => {
    const result = accountRun(['account', 'default', '--account', `${prefix}_nope`])
    expect(result.status).not.toBe(0)
    expect(result.stdout).toContain('not found')
  })

  // --- account delete ---

  test('delete: removes an existing account', () => {
    const name = `${prefix}_del`
    createAccount(name)
    const result = deleteAccount(name)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain(`Account "${name}" deleted`)
    const idx = createdAccounts.indexOf(name)
    if (idx !== -1) createdAccounts.splice(idx, 1)

    const view = accountRun(['account', 'view', '--account', name])
    expect(view.status).not.toBe(0)
  })

  test('delete: missing --account flag exits non-zero', () => {
    const result = accountRun(['account', 'delete', '--yes'])
    expect(result.status).not.toBe(0)
  })

  test('delete: nonexistent account exits non-zero', () => {
    const result = accountRun(['account', 'delete', '--account', `${prefix}_ghost`, '--yes'])
    expect(result.status).not.toBe(0)
    expect(result.stdout).toContain('not found')
  })

  // --- unknown action ---

  test('unknown action exits non-zero', () => {
    const result = accountRun(['account', 'bogus'])
    expect(result.status).not.toBe(0)
  })

  // --- no action ---

  test('no action prints help', () => {
    const result = accountRun(['account'])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('account')
  })
})

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------
describe('init', () => {
  let tmpDir: string

  function setup(files?: Record<string, string>) {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mppx-init-'))
    if (files) {
      for (const [name, content] of Object.entries(files))
        fs.writeFileSync(path.join(tmpDir, name), content)
    }
  }

  function teardown() {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }

  test('creates mppx.config.ts when tsconfig.json exists', async () => {
    setup({ 'tsconfig.json': '{}' })
    const origCwd = process.cwd()
    process.chdir(tmpDir)
    try {
      const { output, exitCode } = await serve(['init'])
      expect(exitCode).toBeUndefined()
      expect(output).toContain('Created mppx.config.ts')
      const content = fs.readFileSync(path.join(tmpDir, 'mppx.config.ts'), 'utf-8')
      expect(content).toContain("import { defineConfig } from 'mppx/cli'")
      expect(content).toContain('methods:')
    } finally {
      process.chdir(origCwd)
      teardown()
    }
  })

  test('creates mppx.config.mjs when package.json has type:module', async () => {
    setup({ 'package.json': '{"type":"module"}' })
    const origCwd = process.cwd()
    process.chdir(tmpDir)
    try {
      const { output, exitCode } = await serve(['init'])
      expect(exitCode).toBeUndefined()
      expect(output).toContain('Created mppx.config.mjs')
      expect(fs.existsSync(path.join(tmpDir, 'mppx.config.mjs'))).toBe(true)
    } finally {
      process.chdir(origCwd)
      teardown()
    }
  })

  test('creates mppx.config.js as fallback', async () => {
    setup()
    const origCwd = process.cwd()
    process.chdir(tmpDir)
    try {
      const { output, exitCode } = await serve(['init'])
      expect(exitCode).toBeUndefined()
      expect(output).toContain('Created mppx.config.js')
      expect(fs.existsSync(path.join(tmpDir, 'mppx.config.js'))).toBe(true)
    } finally {
      process.chdir(origCwd)
      teardown()
    }
  })

  test('errors when config already exists', async () => {
    setup({ 'tsconfig.json': '{}', 'mppx.config.ts': 'existing' })
    const origCwd = process.cwd()
    process.chdir(tmpDir)
    try {
      const { output, exitCode } = await serve(['init'])
      expect(exitCode).toBe(1)
      expect(output).toContain('already exists')
      expect(fs.readFileSync(path.join(tmpDir, 'mppx.config.ts'), 'utf-8')).toBe('existing')
    } finally {
      process.chdir(origCwd)
      teardown()
    }
  })

  test('--force overwrites existing config', async () => {
    setup({ 'tsconfig.json': '{}', 'mppx.config.ts': 'existing' })
    const origCwd = process.cwd()
    process.chdir(tmpDir)
    try {
      const { output, exitCode } = await serve(['init', '--force'])
      expect(exitCode).toBeUndefined()
      expect(output).toContain('Created mppx.config.ts')
      const content = fs.readFileSync(path.join(tmpDir, 'mppx.config.ts'), 'utf-8')
      expect(content).toContain('defineConfig')
    } finally {
      process.chdir(origCwd)
      teardown()
    }
  })
})

test('mppx --help', async () => {
  const { output } = await serve(['--help'])
  expect(output).toContain('mppx')
  expect(output).toContain('<url>')
  expect(output).toContain('account')
  expect(output).toContain('services')
  expect(output).toContain('sign')
})

// ---------------------------------------------------------------------------
// sign
// ---------------------------------------------------------------------------
describe('sign', () => {
  const validChallenge =
    'Payment id="test", realm="test", method="tempo", intent="charge", request="eyJhbW91bnQiOiIxMDAwIiwiY3VycmVuY3kiOiIweDIwYzAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDEiLCJyZWNpcGllbnQiOiIweDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDEiLCJtZXRob2REZXRhaWxzIjp7ImNoYWluSWQiOjEzMzd9fQ"'

  test('--dry-run: validates a valid challenge', async () => {
    const { exitCode, stderr } = await serve(['sign', '--dry-run', '--challenge', validChallenge])
    expect(exitCode).toBeUndefined()
    expect(stderr).toContain('Challenge is valid')
  })

  test('--dry-run: rejects an invalid challenge', async () => {
    const { exitCode, output } = await serve([
      'sign',
      '--dry-run',
      '--challenge',
      'not a valid challenge',
    ])
    expect(exitCode).toBe(2)
    expect(output).toContain('INVALID_CHALLENGE')
  })

  test('error: no challenge provided', async () => {
    const { exitCode, output } = await serve(['sign'])
    expect(exitCode).toBe(2)
    expect(output).toContain('No challenge provided')
  })

  test('error: unsupported method', async () => {
    const challenge = 'Payment id="x", realm="x", method="unknown", intent="charge", request="e30"'
    const { exitCode, output } = await serve(['sign', '--challenge', challenge])
    expect(exitCode).toBe(2)
    expect(output).toContain('Unsupported payment method')
  })

  test('paymentPreferences opt-out is not bypassed by CLI fallback selection', async () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mppx-sign-config-'))
    const configPath = path.join(configDir, 'mppx.config.mjs')
    const mppxModuleUrl = pathToFileURL(path.join(process.cwd(), 'src/index.ts')).href
    const cliModuleUrl = pathToFileURL(path.join(process.cwd(), 'src/cli/config.ts')).href
    fs.writeFileSync(
      configPath,
      `
import { Credential, Method, z } from '${mppxModuleUrl}'
import { defineConfig } from '${cliModuleUrl}'

const alpha = Method.toClient(Method.from({
  name: 'alpha',
  intent: 'charge',
  schema: {
    credential: { payload: z.object({ token: z.string() }) },
    request: z.object({ amount: z.string() }),
  },
}), {
  async createCredential({ challenge }) {
    return Credential.serialize({ challenge, payload: { token: 'alpha-token' } })
  },
})

export default defineConfig({
  methods: [alpha],
  paymentPreferences: ({ alpha }) => ({
    [alpha.charge]: 0,
  }),
})
      `.trim(),
    )

    const challenge =
      'Payment id="x", realm="x", method="alpha", intent="charge", request="eyJhbW91bnQiOiIxIn0"'

    try {
      const { exitCode, output } = await serve([
        'sign',
        '--challenge',
        challenge,
        '--config',
        configPath,
      ])
      expect(exitCode).toBe(2)
      expect(output).toContain('Unsupported payment method')
    } finally {
      fs.rmSync(configDir, { recursive: true, force: true })
    }
  })

  test('selects a later supported challenge from a merged challenge value', async () => {
    const merged = [
      'Payment id="x", realm="x", method="unknown", intent="charge", request="e30"',
      validChallenge,
    ].join(', ')

    const { output, exitCode } = await serve(['sign', '--challenge', merged, '--rpc-url', rpcUrl], {
      env: { MPPX_PRIVATE_KEY: testPrivateKey },
    })

    expect(exitCode).toBeUndefined()
    expect(output.trim()).toMatch(/^Payment\s+\S+/)
  })

  test('error: no account for tempo', async () => {
    const { exitCode, output } = await serve(
      ['sign', '--challenge', validChallenge, '--account', 'nonexistent-sign-test'],
      { env: { MPPX_PRIVATE_KEY: undefined } },
    )
    expect(exitCode).toBe(69)
    expect(output).toContain('not found')
  })

  test('happy path: signs a tempo charge challenge', { timeout: 120_000 }, async () => {
    const { output, stderr, exitCode } = await serve(
      ['sign', '--challenge', validChallenge, '--rpc-url', rpcUrl],
      { env: { MPPX_PRIVATE_KEY: testPrivateKey } },
    )
    if (exitCode) console.info('SIGN DEBUG output:', output, 'stderr:', stderr)
    expect(exitCode).toBeUndefined()
    expect(output.trim()).toMatch(/^Payment\s+\S+/)
  })

  test('rejects unsupported tempo method options', async () => {
    const { output, exitCode } = await serve(
      ['sign', '--challenge', validChallenge, '--rpc-url', rpcUrl, '-M', 'feeToken=0xabc'],
      { env: { MPPX_PRIVATE_KEY: testPrivateKey } },
    )

    expect(exitCode).toBeDefined()
    expect(output).toContain('Unsupported CLI method option')
    expect(output).toContain('feeToken')
  })

  test('happy path: --json outputs authorization', { timeout: 120_000 }, async () => {
    const { output, stderr, exitCode } = await serve(
      ['sign', '--challenge', validChallenge, '--rpc-url', rpcUrl, '--json'],
      { env: { MPPX_PRIVATE_KEY: testPrivateKey } },
    )
    if (exitCode) console.info('SIGN JSON DEBUG output:', output, 'stderr:', stderr)
    expect(exitCode).toBeUndefined()
    const parsed = JSON.parse(output.trim())
    expect(parsed.authorization).toMatch(/^Payment\s+\S+/)
  })

  test(
    'happy path: zero-amount challenge returns proof authorization accepted by live server',
    { timeout: 120_000 },
    async () => {
      const server = Mppx_server.create({
        methods: [tempo.charge({ getClient: () => client })],
        realm: 'cli-sign-zero',
        secretKey: 'cli-test-secret',
      })

      const httpServer = await Http.createServer(async (req, res) => {
        const result = await toNodeListener(
          server.charge({
            amount: '0',
            currency: asset,
            expires: new Date(Date.now() + 60_000).toISOString(),
            recipient: accounts[0].address,
          }),
        )(req, res)
        if (result.status === 402) return
        res.end('zero-dollar-live-sign')
      })

      try {
        const challengeResponse = await fetch(httpServer.url)
        expect(challengeResponse.status).toBe(402)
        const challenge = Challenge.fromResponse(challengeResponse)

        const { output, exitCode } = await serve(
          ['sign', '--challenge', Challenge.serialize(challenge), '--rpc-url', rpcUrl],
          { env: { MPPX_PRIVATE_KEY: testPrivateKey } },
        )

        expect(exitCode).toBeUndefined()

        const authorization = output.trim()
        const credential = Credential.deserialize<{ signature: string; type: 'proof' }>(
          authorization,
        )
        expect(credential.challenge.request.amount).toBe('0')
        expect(credential.payload.type).toBe('proof')
        expect(credential.source).toBe(`did:pkh:eip155:${chain.id}:${testAccount.address}`)

        const response = await fetch(httpServer.url, {
          headers: { Authorization: authorization },
        })
        expect(response.status).toBe(200)
        expect(await response.text()).toBe('zero-dollar-live-sign')

        const receipt = Receipt.fromResponse(response)
        expect(receipt.reference).toBe(credential.challenge.id)
      } finally {
        httpServer.close()
      }
    },
  )

  test(
    'happy path: zero-amount testnet challenge without explicit currency is accepted by live server',
    { timeout: 120_000 },
    async () => {
      const isTestnet = true
      const mainnetCurrency = '0x20C00000000000000000000b9537d11c60E8b50' as `0x${string}`

      const server = Mppx_server.create({
        methods: [
          tempo.charge({
            getClient: () => client,
            ...(isTestnet ? {} : { currency: mainnetCurrency }),
            testnet: isTestnet,
          }),
        ],
        realm: 'cli-sign-zero-testnet',
        secretKey: 'cli-test-secret',
      })

      const httpServer = await Http.createServer(async (req, res) => {
        const result = await toNodeListener(
          server.charge({
            amount: '0',
            chainId: chain.id,
            expires: new Date(Date.now() + 60_000).toISOString(),
            recipient: accounts[0].address,
          }),
        )(req, res)
        if (result.status === 402) return
        res.end('zero-dollar-live-sign-testnet')
      })

      try {
        const challengeResponse = await fetch(httpServer.url)
        expect(challengeResponse.status).toBe(402)
        const challenge = Challenge.fromResponse(challengeResponse)

        const { output, exitCode } = await serve(
          ['sign', '--challenge', Challenge.serialize(challenge), '--rpc-url', rpcUrl],
          { env: { MPPX_PRIVATE_KEY: testPrivateKey } },
        )

        expect(exitCode).toBeUndefined()

        const authorization = output.trim()
        const credential = Credential.deserialize<{ signature: string; type: 'proof' }>(
          authorization,
        )
        expect(credential.challenge.request.amount).toBe('0')
        expect(credential.challenge.request.currency).toBe(
          '0x20c0000000000000000000000000000000000000',
        )
        expect(credential.payload.type).toBe('proof')
        expect(credential.source).toBe(`did:pkh:eip155:${chain.id}:${testAccount.address}`)

        const response = await fetch(httpServer.url, {
          headers: { Authorization: authorization },
        })
        expect(response.status).toBe(200)
        expect(await response.text()).toBe('zero-dollar-live-sign-testnet')

        const receipt = Receipt.fromResponse(response)
        expect(receipt.reference).toBe(credential.challenge.id)
      } finally {
        httpServer.close()
      }
    },
  )
})
