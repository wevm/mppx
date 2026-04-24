import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, expect, test } from 'vp/test'

const cwd = path.resolve(import.meta.dirname, '../..')
const binPath = path.join(cwd, 'src/bin.ts')
const children = new Set<ChildProcessWithoutNullStreams>()
const homes = new Set<string>()

afterEach(() => {
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM')
  }
  children.clear()
  for (const home of homes) fs.rmSync(home, { force: true, recursive: true })
  homes.clear()
})

function startMcpServer() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mppx-mcp-home-'))
  homes.add(home)
  const child = spawn(process.execPath, ['--import', 'tsx', binPath, '--mcp'], {
    cwd,
    env: {
      ...process.env,
      HOME: home,
      NODE_NO_WARNINGS: '1',
      XDG_DATA_HOME: path.join(home, '.local', 'share'),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  children.add(child)

  const client = createLineClient(child)
  return { child, client, home }
}

function createLineClient(child: ChildProcessWithoutNullStreams) {
  let buffer = ''
  const messages: any[] = []
  const nonJsonLines: string[] = []
  let stderr = ''

  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    for (;;) {
      const index = buffer.indexOf('\n')
      if (index === -1) break
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      if (!line.trim()) continue
      try {
        messages.push(JSON.parse(line))
      } catch {
        nonJsonLines.push(line)
      }
    }
  })
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })

  return {
    get nonJsonLines() {
      return nonJsonLines
    },
    get stderr() {
      return stderr
    },
    notify(method: string, params: Record<string, unknown> = {}) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
    },
    request(id: number, method: string, params: Record<string, unknown>) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    },
    async waitFor(id: number) {
      const started = Date.now()
      while (Date.now() - started < 5_000) {
        const message = messages.find((candidate) => candidate.id === id)
        if (message) return message
        if (child.exitCode !== null)
          throw new Error(`MCP server exited before response ${id}: ${child.exitCode}`)
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      throw new Error(
        `Timed out waiting for MCP response ${id}. stderr=${stderr} nonJson=${JSON.stringify(
          nonJsonLines,
        )}`,
      )
    },
  }
}

async function initialize(client: ReturnType<typeof createLineClient>) {
  client.request(1, 'initialize', {
    capabilities: {},
    clientInfo: { name: 'mppx-test', version: '0' },
    protocolVersion: '2025-03-26',
  })
  const response = await client.waitFor(1)
  client.notify('notifications/initialized')
  return response
}

function writeDiscoveryDocument() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mppx-mcp-discovery-'))
  homes.add(dir)
  const file = path.join(dir, 'openapi.json')
  fs.writeFileSync(
    file,
    JSON.stringify({
      info: { title: 'MCP Test', version: '1.0.0' },
      openapi: '3.1.0',
      paths: {
        '/search': {
          post: {
            'x-payment-info': { amount: '100', intent: 'charge', method: 'tempo' },
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
  return file
}

async function callTool(
  client: ReturnType<typeof createLineClient>,
  id: number,
  name: string,
  args: Record<string, unknown> = {},
) {
  client.request(id, 'tools/call', { arguments: args, name })
  const response = await client.waitFor(id)
  await new Promise((resolve) => setTimeout(resolve, 100))
  expect(client.nonJsonLines).toEqual([])
  return response
}

test('mppx --mcp stays alive long enough to handle initialize', async () => {
  const { client } = startMcpServer()

  const response = await initialize(client)

  expect(response.result.serverInfo.name).toBe('mppx')
  expect(client.nonJsonLines).toEqual([])
})

test('tools/list exposes mppx commands with input and output schemas', async () => {
  const { client } = startMcpServer()
  await initialize(client)

  client.request(2, 'tools/list', {})
  const response = await client.waitFor(2)
  const tools = response.result.tools

  expect(tools.map((tool: { name: string }) => tool.name)).toEqual([
    'account_create',
    'account_default',
    'account_delete',
    'account_export',
    'account_fund',
    'account_list',
    'account_view',
    'discover_generate',
    'discover_validate',
    'init',
    'sign',
  ])
  expect(tools.find((tool: { name: string }) => tool.name === 'account_list').outputSchema).toEqual(
    expect.objectContaining({
      properties: expect.objectContaining({ accounts: expect.any(Object) }),
      type: 'object',
    }),
  )
  expect(tools.find((tool: { name: string }) => tool.name === 'sign').inputSchema).toEqual(
    expect.objectContaining({
      properties: expect.objectContaining({ challenge: expect.any(Object) }),
      type: 'object',
    }),
  )
  expect(client.nonJsonLines).toEqual([])
})

test('MCP tool calls return structured data without raw stdout lines', async () => {
  const { client } = startMcpServer()
  await initialize(client)

  const response = await callTool(client, 2, 'account_list')

  expect(response.result.content[0].text).not.toBe('null')
  expect(JSON.parse(response.result.content[0].text)).toEqual({ accounts: [] })
  expect(response.result.structuredContent).toEqual({ accounts: [] })
})

test('MCP session survives mixed success and error tool calls without stdout pollution', async () => {
  const { client } = startMcpServer()
  await initialize(client)

  const discovery = await callTool(client, 2, 'discover_validate', {
    input: writeDiscoveryDocument(),
  })
  expect(JSON.parse(discovery.result.content[0].text)).toEqual({
    errorCount: 0,
    issues: [],
    valid: true,
    warningCount: 0,
  })
  expect(discovery.result.structuredContent).toEqual({
    errorCount: 0,
    issues: [],
    valid: true,
    warningCount: 0,
  })

  const sign = await callTool(client, 3, 'sign')
  expect(sign.result.isError).toBe(true)
  expect(sign.result.content[0].text).toContain('No challenge provided')

  const accounts = await callTool(client, 4, 'account_list')
  expect(JSON.parse(accounts.result.content[0].text)).toEqual({ accounts: [] })
})
