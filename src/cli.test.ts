import { spawn, spawnSync } from 'node:child_process'
import * as path from 'node:path'
import { parseUnits } from 'viem'
import { afterAll, describe, expect, test } from 'vitest'
import * as Http from '~test/Http.js'
import { rpcUrl } from '~test/tempo/prool.js'
import { accounts, asset, client } from '~test/tempo/viem.js'
import * as Mpay_server from './server/Mpay.js'
import { toNodeListener } from './server/Mpay.js'
import { charge as charge_server } from './tempo/server/Charge.js'

const cliPath = path.resolve(import.meta.dirname, 'cli.ts')
const cwd = path.resolve(import.meta.dirname, '..')
const testAccountName = `cli-test-${Date.now()}`
const env = { ...process.env, NODE_NO_WARNINGS: '1' }

function run(args: string[], options?: { input?: string }): string {
  const result = spawnSync('node', ['--import', 'tsx', cliPath, ...args], {
    encoding: 'utf8',
    cwd,
    timeout: 60_000,
    ...(options?.input !== undefined && { input: options.input }),
    env,
  })
  if (result.status !== 0) {
    const msg = result.stderr?.trim() || result.stdout?.trim() || `exit code ${result.status}`
    throw new Error(msg)
  }
  return result.stdout
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

afterAll(() => {
  try {
    run(['account', 'delete', '--account', testAccountName], { input: 'y\n' })
  } catch {}
})

test('mpay --help', () => {
  const stdout = run(['--help'])
  expect(stdout).toMatchInlineSnapshot(`
    "mpay/0.1.0

    Usage:
      $ mpay [url]

    Commands:
      [url]             Make HTTP request with automatic payment
      account [action]  Manage accounts (create, delete, fund, list, view)

    For more info, run any command with the \`--help\` flag:
      $ mpay --help
      $ mpay account --help

    Actions:
      create  Create new account
      delete  Delete account
      fund    Fund account with testnet tokens
      list    List all accounts
      view    View account address

    Options:
      -A, --user-agent <ua>  Set User-Agent header 
      -d, --data <data>      Send request body (implies POST unless -X is set) 
      -f, --fail             Fail silently on HTTP errors (exit 22) 
      -H, --header <header>  Add header (repeatable) 
      -i, --include          Include response headers in output 
      -k, --insecure         Skip TLS certificate verification (true for localhost/.local) 
      -L, --location         Follow redirects 
      -s, --silent           Silent mode (suppress progress and info) 
      -v, --verbose          Make operation more talkative 
      -X, --method <method>  HTTP method 
      --accept <type>        Set Accept header (e.g. json, markdown, text/html) 
      --account <name>       Account name (default: default) 
      --json <json>          Send JSON body (sets Content-Type, implies POST) 
      -M, --mainnet          Use mainnet 
      --rpc-url <url>        Custom RPC URL 
      --yes                  Skip confirmation prompts 
      -V, --version          Display version number 
      -h, --help             Display this message 

    Examples:
    mpay example.com/foo/bar/baz --accept markdown
    mpay example.com/test -A claude
    mpay example.com/api -X POST --json '{"key":"value"}'
    "
  `)
})

describe('mpay account', () => {
  let address: string

  test('create', () => {
    const stdout = run(['account', 'create', '--account', testAccountName])
    address = stdout.trim().split('\n')[0]!
    expect(address).toMatch(/^0x[0-9a-fA-F]{40}$/)
  })

  test('list', () => {
    const stdout = run(['account', 'list'])
    expect(stdout).toContain(testAccountName)
    expect(stdout).toContain(address)
  })

  test('view', () => {
    const stdout = run(['account', 'view', '--account', testAccountName])
    expect(stdout).toContain(address)
  })
})

describe('mpay [url]', () => {
  const realm = 'cli-test.example.com'
  const secretKey = 'cli-test-secret'

  test('makes payment and receives response', { timeout: 120_000 }, async () => {
    const addressOutput = run(['account', 'view', '--account', testAccountName]).trim()
    const address = addressOutput.split('\n')[0]! as `0x${string}`

    const { Actions } = await import('viem/tempo')
    await Actions.token.transferSync(client, {
      account: accounts[0],
      chain: client.chain,
      token: asset,
      to: address,
      amount: parseUnits('100', 6),
    })

    const server = Mpay_server.create({
      methods: [charge_server({ getClient: () => client })],
      realm,
      secretKey,
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
      const { stdout } = await runAsync(
        [httpServer.url, '--rpc-url', rpcUrl, '--account', testAccountName, '--yes', '-s'],
        { input: '' },
      )
      expect(stdout).toContain('paid')
    } finally {
      httpServer.close()
    }
  })
})
