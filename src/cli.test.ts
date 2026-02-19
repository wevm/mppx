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
  options?: { input?: string },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['--import', 'tsx', cliPath, ...args], {
      cwd,
      env,
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

  test('error: no account found', { timeout: 60_000 }, () => {
    const result = spawnSync(
      'node',
      ['--import', 'tsx', cliPath, 'http://localhost:1', '--account', 'nonexistent-account'],
      {
        encoding: 'utf8',
        cwd,
        timeout: 60_000,
        env: { ...process.env, NODE_NO_WARNINGS: '1' },
      },
    )
    expect(result.status).not.toBe(0)
    expect(result.stdout).toContain('Account "nonexistent-account" not found')
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
        [httpServer.url, '--rpc-url', rpcUrl, '-s', '--deposit', '10'],
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
          [httpServer.url, '--rpc-url', rpcUrl, '--confirm', '--deposit', '10'],
          { input: 'y\nn\n' },
        )
        expect(first.stdout).toContain('scraped-content')

        // Extract channel ID from stderr (logged as "Channel opened 0x...")
        const match = first.stderr.match(/Channel opened (0x[0-9a-fA-F]+)/)
        expect(match).toBeTruthy()
        const channelId = match![1]!

        // Second request: reuse the channel via --channel
        const second = await runAsync(
          [httpServer.url, '--rpc-url', rpcUrl, '-s', '--channel', channelId, '--deposit', '10'],
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
      const { stdout } = await runAsync([httpServer.url, '--rpc-url', rpcUrl, '--deposit', '10'], {
        input: '',
      })
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
    expect(result.stderr).toContain('Unknown action: bogus')
  })

  // --- no action ---

  test('no action prints help', () => {
    const result = accountRun(['account'])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('account [action]')
  })
})

test('mppx --help', () => {
  const { version } = require('../package.json') as { version: string }
  const stdout = run(['--help']).replace(`mppx/${version}`, 'mppx/x.y.z')
  expect(stdout).toMatchInlineSnapshot(`
    "mppx/x.y.z

    Usage:
      $ mppx [url]

    Commands:
      [url]             Make HTTP request with automatic payment
      account [action]  Manage accounts (create, default, delete, fund, list, view)

    For more info, run any command with the \`--help\` flag:
      $ mppx --help
      $ mppx account --help

    Actions:
      create   Create new account
      default  Set default account
      delete   Delete account
      fund     Fund account with testnet tokens
      list     List all accounts
      view     View account address

    Options:
      -a, --account <name>   Account name (env: MPPX_ACCOUNT) 
      -d, --data <data>      Send request body (implies POST unless -X is set) 
      -f, --fail             Fail silently on HTTP errors (exit 22) 
      -i, --include          Include response headers in output 
      -k, --insecure         Skip TLS certificate verification (true for localhost/.local) 
      -r, --rpc-url <url>    RPC endpoint, defaults to public RPC for chain (env: MPPX_RPC_URL) 
      -s, --silent           Silent mode (suppress progress and info) 
      -v, --verbose          Show request/response headers 
      -A, --user-agent <ua>  Set User-Agent header 
      -H, --header <header>  Add header (repeatable) 
      -L, --location         Follow redirects 
      -X, --method <method>  HTTP method 
      --channel <id>         Reuse existing session channel ID 
      --confirm              Show confirmation prompts 
      --deposit <amount>     Deposit amount for session payments (human-readable units) 
      --json <json>          Send JSON body (sets Content-Type and Accept, implies POST) 
      -V, --version          Display version number 
      -h, --help             Display this message 

    Examples:
    mppx example.com/content
    mppx example.com/api --json '{"key":"value"}'
    "
  `)
})
