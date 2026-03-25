import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { parseUnits } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { Addresses } from 'viem/tempo'
import { afterAll, describe, expect, test } from 'vp/test'
import * as Http from '~test/Http.js'
import { rpcUrl } from '~test/tempo/prool.js'
import { deployEscrow } from '~test/tempo/session.js'
import { accounts, asset, client, fundAccount } from '~test/tempo/viem.js'

import * as Credential from '../Credential.js'
import * as Mppx_server from '../server/Mppx.js'
import { toNodeListener } from '../server/Mppx.js'
import * as Store from '../Store.js'
import { stripe as stripe_server } from '../stripe/server/Methods.js'
import { tempo } from '../tempo/server/Methods.js'
import type { SessionCredentialPayload } from '../tempo/session/Types.js'
import cli from './cli.js'

const testPrivateKey = generatePrivateKey()
const testAccount = privateKeyToAccount(testPrivateKey)

async function serve(argv: string[], options?: { env?: Record<string, string | undefined> }) {
  let output = ''
  let stderr = ''
  let exitCode: number | undefined
  const saved: Record<string, string | undefined> = {}
  if (options?.env) {
    for (const [key, value] of Object.entries(options.env)) {
      saved[key] = process.env[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
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
              responses: { '200': { description: 'OK' }, '402': { description: 'Payment Required' } },
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
  const accountEnv = { ...process.env, NODE_NO_WARNINGS: '1' }
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
})
