import { spawn, spawnSync } from 'node:child_process'
import * as path from 'node:path'
import { parseUnits } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { Addresses } from 'viem/tempo'
import { afterAll, describe, expect, test } from 'vitest'
import * as Http from '~test/Http.js'
import { rpcUrl } from '~test/tempo/prool.js'
import { deployEscrow } from '~test/tempo/session.js'
import { accounts, asset, client, fundAccount } from '~test/tempo/viem.js'
import * as Store from './Store.js'
import * as Mppx_server from './server/Mppx.js'
import { toNodeListener } from './server/Mppx.js'
import { stripe as stripe_server } from './stripe/server/Methods.js'
import { tempo } from './tempo/server/Methods.js'

const cliPath = path.resolve(import.meta.dirname, 'cli.ts')
const cwd = path.resolve(import.meta.dirname, '..')
const testPrivateKey = generatePrivateKey()
const testAccount = privateKeyToAccount(testPrivateKey)
const env = { ...process.env, NODE_NO_WARNINGS: '1', MPPX_PRIVATE_KEY: testPrivateKey }

function run(args: string[], options?: { input?: string }): string {
  const result = runRaw(args, options)
  if (result.status !== 0) {
    const msg = result.stderr?.trim() || result.stdout?.trim() || `exit code ${result.status}`
    throw new Error(msg)
  }
  return result.stdout
}

function runRaw(
  args: string[],
  options?: { input?: string; env?: NodeJS.ProcessEnv },
): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync('node', ['--import', 'tsx', cliPath, ...args], {
    encoding: 'utf8',
    cwd,
    timeout: 60_000,
    ...(options?.input !== undefined && { input: options.input }),
    env: options?.env ?? env,
  })
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status }
}

function runAsync(
  args: string[],
  options?: { input?: string; env?: NodeJS.ProcessEnv },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['--import', 'tsx', cliPath, ...args], {
      cwd,
      env: options?.env ?? env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString()
    })
    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString()
    })

    if (options?.input !== undefined) {
      child.stdin.write(options.input)
      child.stdin.end()
    } else {
      child.stdin.end()
    }

    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`Timed out.\nstdout: ${stdout}\nstderr: ${stderr}`))
    }, 60_000)

    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) reject(new Error(stderr.trim() || `exit code ${code}`))
      else resolve({ stdout, stderr })
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

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
      const { stdout } = await runAsync([httpServer.url, '--rpc-url', rpcUrl, '-s'], {
        input: '',
      })
      expect(stdout).toContain('paid')
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
      const result = await runAsync([httpServer.url, '--account', 'nonexistent-account'], {
        input: '',
        env: { ...process.env, NODE_NO_WARNINGS: '1' },
      }).catch((err) => err as Error)
      expect(result).toBeInstanceOf(Error)
      expect((result as Error).message).toContain('Account "nonexistent-account" not found')
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
      const { stdout } = await runAsync(
        [httpServer.url, '--rpc-url', rpcUrl, '-s', '-M', 'deposit=10'],
        { input: '' },
      )
      expect(stdout).toContain('scraped-content')
    } finally {
      httpServer.close()
    }
  })

  test(
    '--channel reuse: second request reuses existing channel',
    { timeout: 120_000 },
    async () => {
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
        realm: 'cli-test-channel-reuse',
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
        // First request: open a channel, answer "y" to proceed, "n" to close channel
        const first = await runAsync(
          [httpServer.url, '--rpc-url', rpcUrl, '--confirm', '-M', 'deposit=10'],
          { input: 'y\nn\n' },
        )
        expect(first.stdout).toContain('scraped-content')

        // Extract channel ID from stderr (logged as "Channel opened 0x...")
        const match = first.stderr.match(/Channel opened (0x[0-9a-fA-F]+)/)
        expect(match).toBeTruthy()
        const channelId = match![1]!

        // Second request: reuse the channel via -M channel=<id>
        const second = await runAsync(
          [
            httpServer.url,
            '--rpc-url',
            rpcUrl,
            '-s',
            '-M',
            `channel=${channelId}`,
            '-M',
            'deposit=10',
          ],
          { input: '' },
        )
        expect(second.stdout).toContain('scraped-content')
      } finally {
        httpServer.close()
      }
    },
  )

  test('error: --fail exits on server error', { timeout: 60_000 }, async () => {
    const httpServer = await Http.createServer(async (_req, res) => {
      res.writeHead(500)
      res.end('Internal Server Error')
    })

    try {
      await expect(
        runAsync([httpServer.url, '--rpc-url', rpcUrl, '--fail'], { input: '' }),
      ).rejects.toThrow()
    } finally {
      httpServer.close()
    }
  })
})

describe.skipIf(!process.env.VITE_STRIPE_SECRET_KEY)('stripe charge (integration)', () => {
  test('happy path: makes Stripe payment via real API', { timeout: 120_000 }, async () => {
    const stripeSecretKey = process.env.VITE_STRIPE_SECRET_KEY!

    const server = Mppx_server.create({
      methods: [
        stripe_server.charge({
          secretKey: stripeSecretKey,
          networkId: 'internal',
          paymentMethodTypes: ['card'],
        }),
      ],
      realm: 'cli-test-stripe',
      secretKey: 'cli-test-secret',
    })

    const httpServer = await Http.createServer(async (req, res) => {
      const result = await toNodeListener(
        server.charge({
          amount: '1',
          currency: 'usd',
          decimals: 2,
        }),
      )(req, res)
      if (result.status === 402) return
      res.end('paid')
    })

    try {
      const { stdout } = await runAsync(
        [httpServer.url, '-M', 'paymentMethod=pm_card_visa', '-s'],
        {
          input: '',
          env: {
            ...env,
            MPPX_STRIPE_SECRET_KEY: stripeSecretKey,
            MPPX_PRIVATE_KEY: undefined as unknown as string,
          },
        },
      )
      expect(stdout).toContain('paid')
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
      const { stdout } = await runAsync(
        [httpServer.url, '--rpc-url', rpcUrl, '-M', 'deposit=10'],
        {
          input: '',
        },
      )
      expect(stdout.trim()).toBe('Hello world!')
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
      await expect(
        runAsync([httpServer.url, '--rpc-url', rpcUrl, '--fail'], { input: '' }),
      ).rejects.toThrow()
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
      const { stdout } = await runAsync(
        [appServer.url, '-s', '-M', 'paymentMethod=pm_card_visa'],
        {
          input: '',
          env: {
            ...process.env,
            NODE_NO_WARNINGS: '1',
            MPPX_STRIPE_SECRET_KEY: 'sk_test_mock',
            MPPX_STRIPE_SPT_URL: sptServer.url,
          },
        },
      )
      expect(stdout).toContain('paid')
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
      const result = await runAsync(
        [appServer.url, '-s', '-M', 'paymentMethod=pm_card_visa'],
        {
          input: '',
          env: {
            ...process.env,
            NODE_NO_WARNINGS: '1',
            MPPX_STRIPE_SECRET_KEY: '',
          },
        },
      ).catch((err) => err as Error)
      expect(result).toBeInstanceOf(Error)
      expect((result as Error).message).toContain('MPPX_STRIPE_SECRET_KEY')
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
      const result = await runAsync(
        [appServer.url, '-s', '-M', 'paymentMethod=pm_card_visa'],
        {
          input: '',
          env: {
            ...process.env,
            NODE_NO_WARNINGS: '1',
            MPPX_STRIPE_SECRET_KEY: 'sk_live_fake',
          },
        },
      ).catch((err) => err as Error)
      expect(result).toBeInstanceOf(Error)
      expect((result as Error).message).toContain('test mode')
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
  // Env without MPPX_PRIVATE_KEY so account commands use the keychain
  const accountEnv = { ...process.env, NODE_NO_WARNINGS: '1' }
  const prefix = `__mppx_test_${Date.now()}`
  const createdAccounts: string[] = []

  function accountRun(args: string[], options?: { input?: string }) {
    return runRaw(args, { ...options, env: accountEnv })
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
    // Second create with same name (non-interactive, stdin closed) should not succeed
    const result = accountRun(['account', 'create', '--account', name], { input: '' })
    // The CLI prompts for a different name; with empty stdin it exits
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
    // Remove from cleanup list since already deleted
    const idx = createdAccounts.indexOf(name)
    if (idx !== -1) createdAccounts.splice(idx, 1)

    // Verify it's gone
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

test('mppx --help', () => {
  const stdout = run(['--help'])
  expect(stdout).toContain('mppx')
  expect(stdout).toContain('<url>')
  expect(stdout).toContain('account')
})
