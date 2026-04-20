import { randomUUID } from 'node:crypto'
import * as http from 'node:http'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { session as tempo_session_client, tempo as tempo_client } from 'mppx/client'
import { Mppx as Mppx_server, tempo as tempo_server } from 'mppx/server'
import type { Address } from 'viem'
import { readContract } from 'viem/actions'
import { Actions, Addresses } from 'viem/tempo'
import { beforeAll, describe, expect, test } from 'vp/test'
import { nodeEnv } from '~test/config.js'
import { deployEscrow, signTopUpChannel } from '~test/tempo/session.js'
import { accounts, asset, client as testClient, fundAccount } from '~test/tempo/viem.js'

import * as Credential from '../../Credential.js'
import * as core_Mcp from '../../Mcp.js'
import * as Store from '../../Store.js'
import * as ChannelStore from '../../tempo/session/ChannelStore.js'
import type { SessionReceipt } from '../../tempo/session/Types.js'
import * as McpServer_transport from '../server/Transport.js'
import * as McpClient from './McpClient.js'

const realm = 'api.example.com'
const secretKey = 'test-secret-key'
const chargeAmountRaw = 1_000_000n
const doubleSessionAmountRaw = chargeAmountRaw * 2n
const topUpAmountRaw = chargeAmountRaw * 3n

let escrowContract: Address

beforeAll(async () => {
  escrowContract = await deployEscrow()
  await fundAccount({ address: accounts[4].address, token: Addresses.pathUsd })
  await fundAccount({ address: accounts[4].address, token: asset })
  await fundAccount({ address: accounts[2].address, token: Addresses.pathUsd })
  await fundAccount({ address: accounts[2].address, token: asset })
}, 60_000)

describe.runIf(nodeEnv === 'localnet')('McpClient.wrap integration', () => {
  const scenarios: readonly Scenario[] = [
    {
      name: 'charge intent settles a paid MCP tool against the live chain',
      async run(harness: Harness) {
        const beforeBalance = await getTokenBalance(accounts[0].address)

        const first = await harness.mcp.callTool({ name: 'charge_tool', arguments: {} })
        const second = await harness.mcp.callTool({ name: 'charge_tool', arguments: {} })

        const afterBalance = await getTokenBalance(accounts[0].address)

        expect(first.content).toEqual([{ type: 'text', text: 'charge tool executed' }])
        expect(second.content).toEqual([{ type: 'text', text: 'charge tool executed' }])
        expect(first.receipt?.status).toBe('success')
        expect(second.receipt?.status).toBe('success')
        expect(first.receipt?.method).toBe('tempo')
        expect(second.receipt?.method).toBe('tempo')
        expect(first.receipt?.reference).toMatch(/^0x[0-9a-f]+$/)
        expect(second.receipt?.reference).toMatch(/^0x[0-9a-f]+$/)
        expect(second.receipt?.reference).not.toBe(first.receipt?.reference)
        expect(afterBalance - beforeBalance).toBe(chargeAmountRaw * 2n)
      },
    },
    {
      name: 'session intent reuses one live channel and advances cumulative metering',
      async run(harness: Harness) {
        const first = await harness.mcp.callTool({ name: 'session_tool', arguments: {} })
        const second = await harness.mcp.callTool({ name: 'session_tool', arguments: {} })

        const firstReceipt = first.receipt as SessionReceipt | undefined
        const secondReceipt = second.receipt as SessionReceipt | undefined

        expect(first.content).toEqual([{ type: 'text', text: 'session tool executed' }])
        expect(second.content).toEqual([{ type: 'text', text: 'session tool executed' }])
        expect(firstReceipt?.intent).toBe('session')
        expect(secondReceipt?.intent).toBe('session')
        expect(firstReceipt?.channelId).toMatch(/^0x[0-9a-f]{64}$/)
        expect(secondReceipt?.channelId).toBe(firstReceipt?.channelId)
        expect(firstReceipt?.acceptedCumulative).toBe(chargeAmountRaw.toString())
        expect(secondReceipt?.acceptedCumulative).toBe((chargeAmountRaw * 2n).toString())

        const channel = await harness.sessionStore.getChannel(secondReceipt!.channelId)
        expect(channel?.highestVoucherAmount).toBe(chargeAmountRaw * 2n)
        expect(channel?.highestVoucher?.channelId).toBe(secondReceipt?.channelId)
      },
    },
    {
      name: 'one live MCP server can serve charge and session tools in the same client session',
      async run(harness: Harness) {
        const chargeResult = await harness.mcp.callTool({ name: 'charge_tool', arguments: {} })
        const sessionResult = await harness.mcp.callTool({ name: 'session_tool', arguments: {} })

        const sessionReceipt = sessionResult.receipt as SessionReceipt | undefined

        expect(chargeResult.content).toEqual([{ type: 'text', text: 'charge tool executed' }])
        expect(chargeResult.receipt?.status).toBe('success')
        expect(chargeResult.receipt?.reference).toMatch(/^0x[0-9a-f]+$/)
        expect(sessionResult.content).toEqual([{ type: 'text', text: 'session tool executed' }])
        expect(sessionReceipt?.intent).toBe('session')
        expect(sessionReceipt?.acceptedCumulative).toBe(chargeAmountRaw.toString())

        const channel = await harness.sessionStore.getChannel(sessionReceipt!.channelId)
        expect(channel?.highestVoucherAmount).toBe(chargeAmountRaw)
      },
    },
    {
      name: 'session intent reuses one live channel across multiple MCP tools with different costs',
      async run(harness: Harness) {
        const first = await harness.mcp.callTool({ name: 'session_tool', arguments: {} })
        const second = await harness.mcp.callTool({ name: 'session_tool_double', arguments: {} })
        const third = await harness.mcp.callTool({ name: 'session_tool', arguments: {} })

        const firstReceipt = first.receipt as SessionReceipt | undefined
        const secondReceipt = second.receipt as SessionReceipt | undefined
        const thirdReceipt = third.receipt as SessionReceipt | undefined

        expect(first.content).toEqual([{ type: 'text', text: 'session tool executed' }])
        expect(second.content).toEqual([{ type: 'text', text: 'session double tool executed' }])
        expect(third.content).toEqual([{ type: 'text', text: 'session tool executed' }])
        expect(secondReceipt?.channelId).toBe(firstReceipt?.channelId)
        expect(thirdReceipt?.channelId).toBe(firstReceipt?.channelId)
        expect(firstReceipt?.acceptedCumulative).toBe(chargeAmountRaw.toString())
        expect(secondReceipt?.acceptedCumulative).toBe(
          (chargeAmountRaw + doubleSessionAmountRaw).toString(),
        )
        expect(thirdReceipt?.acceptedCumulative).toBe(
          (chargeAmountRaw * 2n + doubleSessionAmountRaw).toString(),
        )

        const channel = await harness.sessionStore.getChannel(thirdReceipt!.channelId)
        expect(channel?.highestVoucherAmount).toBe(chargeAmountRaw * 2n + doubleSessionAmountRaw)
      },
    },
    {
      name: 'session intent accepts replayed vouchers without advancing cumulative state',
      async run(harness: Harness) {
        const openChallenge = await getPaymentChallenge(harness.sdkClient, 'session_tool')
        const openCredential = await harness.sessionMethod.createCredential({
          challenge: openChallenge,
          context: {},
        })
        const opened = await callToolWithCredential(
          harness.sdkClient,
          'session_tool',
          openCredential,
        )

        const openReceipt = opened.receipt as SessionReceipt | undefined
        expect(openReceipt?.acceptedCumulative).toBe(chargeAmountRaw.toString())

        const voucherChallenge = await getPaymentChallenge(harness.sdkClient, 'session_tool')
        const replayedCumulativeRaw = (chargeAmountRaw * 3n).toString()
        const voucherCredential = await harness.sessionMethod.createCredential({
          challenge: voucherChallenge,
          context: {
            action: 'voucher',
            channelId: openReceipt!.channelId,
            cumulativeAmountRaw: replayedCumulativeRaw,
          },
        })
        const firstVoucher = await callToolWithCredential(
          harness.sdkClient,
          'session_tool',
          voucherCredential,
        )
        const replayedVoucher = await callToolWithCredential(
          harness.sdkClient,
          'session_tool',
          voucherCredential,
        )

        const firstReceipt = firstVoucher.receipt as SessionReceipt | undefined
        const replayReceipt = replayedVoucher.receipt as SessionReceipt | undefined

        expect(firstVoucher.content).toEqual([{ type: 'text', text: 'session tool executed' }])
        expect(replayedVoucher.content).toEqual([{ type: 'text', text: 'session tool executed' }])
        expect(firstReceipt?.channelId).toBe(openReceipt?.channelId)
        expect(replayReceipt?.channelId).toBe(openReceipt?.channelId)
        expect(firstReceipt?.acceptedCumulative).toBe(replayedCumulativeRaw)
        expect(replayReceipt?.acceptedCumulative).toBe(replayedCumulativeRaw)

        const channel = await harness.sessionStore.getChannel(openReceipt!.channelId)
        expect(channel?.highestVoucherAmount).toBe(chargeAmountRaw * 3n)
      },
    },
    {
      name: 'session intent rejects replaying a credential across a different MCP tool',
      async run(harness: Harness) {
        const openChallenge = await getPaymentChallenge(harness.sdkClient, 'session_tool')
        const openCredential = await harness.sessionMethod.createCredential({
          challenge: openChallenge,
          context: {},
        })
        const opened = await callToolWithCredential(
          harness.sdkClient,
          'session_tool',
          openCredential,
        )

        const openReceipt = opened.receipt as SessionReceipt | undefined
        expect(openReceipt?.acceptedCumulative).toBe(chargeAmountRaw.toString())

        const mismatch = await getPaymentRequiredError(
          harness.sdkClient,
          'session_tool_double',
          openCredential,
        )

        expect(mismatch.data.problem?.type).toBe(
          'https://paymentauth.org/problems/invalid-challenge',
        )
        expect(mismatch.data.challenges).toHaveLength(1)
        expect(mismatch.data.challenges[0]?.method).toBe('tempo')
        expect(mismatch.data.challenges[0]?.intent).toBe('session')
        expect(mismatch.data.challenges[0]?.request.amount).toBe(doubleSessionAmountRaw.toString())

        const channel = await harness.sessionStore.getChannel(openReceipt!.channelId)
        expect(channel?.highestVoucherAmount).toBe(chargeAmountRaw)
      },
    },
    {
      name: 'session intent can top up a live MCP channel and continue metering on the same channel',
      sessionFeePayer: true,
      sessionMaxDeposit: '2',
      async run(harness: Harness) {
        const openChallenge = await getPaymentChallenge(harness.sdkClient, 'session_tool')
        const openCredential = await harness.sessionMethod.createCredential({
          challenge: openChallenge,
          context: {},
        })
        const opened = await callToolWithCredential(
          harness.sdkClient,
          'session_tool',
          openCredential,
        )

        const openReceipt = opened.receipt as SessionReceipt | undefined
        expect(opened.content).toEqual([{ type: 'text', text: 'session tool executed' }])
        expect(openReceipt?.acceptedCumulative).toBe(chargeAmountRaw.toString())

        const voucherChallenge = await getPaymentChallenge(harness.sdkClient, 'session_tool')
        const voucherCredential = await harness.sessionMethod.createCredential({
          challenge: voucherChallenge,
          context: {},
        })
        const metered = await callToolWithCredential(
          harness.sdkClient,
          'session_tool',
          voucherCredential,
        )

        const meteredReceipt = metered.receipt as SessionReceipt | undefined
        expect(metered.content).toEqual([{ type: 'text', text: 'session tool executed' }])
        expect(meteredReceipt?.channelId).toBe(openReceipt?.channelId)
        expect(meteredReceipt?.acceptedCumulative).toBe((chargeAmountRaw * 2n).toString())

        const { serializedTransaction } = await signTopUpChannel({
          escrow: escrowContract,
          feePayer: true,
          payer: accounts[2],
          channelId: openReceipt!.channelId,
          token: asset,
          amount: topUpAmountRaw,
        })
        const topUpChallenge = await getPaymentChallenge(harness.sdkClient, 'session_tool')
        const topUpCredential = await harness.sessionMethod.createCredential({
          challenge: topUpChallenge,
          context: {
            action: 'topUp',
            additionalDepositRaw: topUpAmountRaw.toString(),
            channelId: openReceipt!.channelId,
            transaction: serializedTransaction,
          },
        })
        const toppedUp = await callToolWithCredential(
          harness.sdkClient,
          'session_tool',
          topUpCredential,
        )

        const topUpReceipt = toppedUp.receipt as SessionReceipt | undefined
        expect(toppedUp.content).toEqual([])
        expect(topUpReceipt?.channelId).toBe(openReceipt?.channelId)
        expect(topUpReceipt?.acceptedCumulative).toBe((chargeAmountRaw * 2n).toString())
        expect(topUpReceipt?.spent).toBe(meteredReceipt?.spent)
        expect(topUpReceipt?.units).toBe(meteredReceipt?.units)

        const afterTopUpChallenge = await getPaymentChallenge(harness.sdkClient, 'session_tool')
        const afterTopUpCredential = await harness.sessionMethod.createCredential({
          challenge: afterTopUpChallenge,
          context: {},
        })
        const resumed = await callToolWithCredential(
          harness.sdkClient,
          'session_tool',
          afterTopUpCredential,
        )

        const resumedReceipt = resumed.receipt as SessionReceipt | undefined
        expect(resumed.content).toEqual([{ type: 'text', text: 'session tool executed' }])
        expect(resumedReceipt?.channelId).toBe(openReceipt?.channelId)
        expect(resumedReceipt?.acceptedCumulative).toBe((chargeAmountRaw * 3n).toString())

        const channel = await harness.sessionStore.getChannel(openReceipt!.channelId)
        expect(channel?.deposit).toBe(chargeAmountRaw * 2n + topUpAmountRaw)
        expect(channel?.highestVoucherAmount).toBe(chargeAmountRaw * 3n)
        expect(channel?.spent).toBeGreaterThanOrEqual(BigInt(topUpReceipt!.spent))
        expect(channel?.units).toBeGreaterThanOrEqual(topUpReceipt?.units ?? 0)
      },
    },
    {
      name: 'session intent can close a live MCP channel and reopen on the next request',
      async run(harness: Harness) {
        const openChallenge = await getPaymentChallenge(harness.sdkClient, 'session_tool')
        const openCredential = await harness.sessionMethod.createCredential({
          challenge: openChallenge,
          context: {},
        })
        const opened = await callToolWithCredential(
          harness.sdkClient,
          'session_tool',
          openCredential,
        )

        const openReceipt = opened.receipt as SessionReceipt | undefined
        expect(openReceipt?.acceptedCumulative).toBe(chargeAmountRaw.toString())

        const voucherChallenge = await getPaymentChallenge(harness.sdkClient, 'session_tool')
        const voucherCredential = await harness.sessionMethod.createCredential({
          challenge: voucherChallenge,
          context: {},
        })
        const metered = await callToolWithCredential(
          harness.sdkClient,
          'session_tool',
          voucherCredential,
        )

        const meteredReceipt = metered.receipt as SessionReceipt | undefined
        expect(meteredReceipt?.channelId).toBe(openReceipt?.channelId)
        expect(meteredReceipt?.acceptedCumulative).toBe((chargeAmountRaw * 2n).toString())

        const closeChallenge = await getPaymentChallenge(harness.sdkClient, 'session_tool')
        const closeCredential = await harness.sessionMethod.createCredential({
          challenge: closeChallenge,
          context: {
            action: 'close',
            channelId: openReceipt!.channelId,
            cumulativeAmountRaw: (chargeAmountRaw * 2n).toString(),
          },
        })
        const closed = await callToolWithCredential(
          harness.sdkClient,
          'session_tool',
          closeCredential,
        )

        const closeReceipt = closed.receipt as SessionReceipt | undefined
        expect(closed.content).toEqual([])
        expect(closeReceipt?.channelId).toBe(openReceipt?.channelId)
        expect(closeReceipt?.acceptedCumulative).toBe((chargeAmountRaw * 2n).toString())
        expect(closeReceipt?.txHash).toMatch(/^0x[0-9a-f]+$/)

        const closedChannel = await harness.sessionStore.getChannel(openReceipt!.channelId)
        expect(closedChannel?.finalized).toBe(true)

        const reopenedChallenge = await getPaymentChallenge(harness.sdkClient, 'session_tool')
        const reopenedCredential = await harness.sessionMethod.createCredential({
          challenge: reopenedChallenge,
          context: {},
        })
        const reopened = await callToolWithCredential(
          harness.sdkClient,
          'session_tool',
          reopenedCredential,
        )

        const reopenedReceipt = reopened.receipt as SessionReceipt | undefined
        expect(reopened.content).toEqual([{ type: 'text', text: 'session tool executed' }])
        expect(reopenedReceipt?.acceptedCumulative).toBe(chargeAmountRaw.toString())
        expect(reopenedReceipt?.channelId).not.toBe(openReceipt?.channelId)
      },
    },
  ]

  for (const scenario of scenarios) {
    test(
      scenario.name,
      async () => {
        const harness = await createHarness({
          sessionFeePayer: scenario.sessionFeePayer,
          sessionMaxDeposit: scenario.sessionMaxDeposit,
        })

        try {
          await scenario.run(harness)
        } finally {
          await harness.close()
        }
      },
      30_000,
    )
  }
})

type WrappedClient = {
  callTool: (
    params: { name: string; arguments?: Record<string, unknown>; _meta?: Record<string, unknown> },
    options?: { context?: unknown; timeout?: number },
  ) => Promise<McpClient.CallToolResult>
}

type SessionMethod = ReturnType<typeof tempo_session_client>
type SessionChallenge = Parameters<SessionMethod['createCredential']>[0]['challenge']
type PaymentRequiredMcpError = Error & {
  data: {
    challenges: SessionChallenge[]
    problem?: { type?: string | undefined } | undefined
  }
}

type Scenario = {
  name: string
  run: (harness: Harness) => Promise<void>
  sessionFeePayer?: boolean | undefined
  sessionMaxDeposit?: string | undefined
}

type Harness = {
  close: () => Promise<void>
  mcp: WrappedClient
  sdkClient: Client
  sessionMethod: SessionMethod
  sessionStore: ChannelStore.ChannelStore
}

async function createHarness(options?: {
  sessionFeePayer?: boolean | undefined
  sessionDeposit?: string | undefined
  sessionMaxDeposit?: string | undefined
}): Promise<Harness> {
  const sessionBackingStore = Store.memory()
  const sessionStore = ChannelStore.fromStore(sessionBackingStore)
  const [chargeMethod] = tempo_client({
    account: accounts[1],
    getClient: () => testClient,
  })
  const sessionMethod = tempo_session_client({
    account: accounts[2],
    escrowContract,
    getClient: () => testClient,
    ...(options?.sessionMaxDeposit
      ? { maxDeposit: options.sessionMaxDeposit }
      : { deposit: options?.sessionDeposit ?? '5' }),
  })

  const payment = Mppx_server.create({
    methods: [
      tempo_server.charge({
        account: accounts[0],
        currency: asset,
        getClient: () => testClient,
      }),
      tempo_server.session({
        account: accounts[0],
        currency: asset,
        escrowContract,
        getClient: () => testClient,
        store: sessionBackingStore,
        ...(options?.sessionFeePayer ? { feePayer: accounts[4] } : {}),
      }),
    ],
    realm,
    secretKey,
    transport: McpServer_transport.mcpSdk(),
  })

  const mcpServer = new McpServer({ name: 'test-server', version: '1.0.0' })

  mcpServer.registerTool('charge_tool', { description: 'Charge metered tool' }, async (extra) => {
    const result = await (payment.charge({ amount: '1' }) as (input: unknown) => Promise<any>)(
      extra,
    )
    if (result.status === 402) throw result.challenge

    return result.withReceipt({
      content: [{ type: 'text' as const, text: 'charge tool executed' }],
    }) as never
  })

  mcpServer.registerTool('session_tool', { description: 'Session metered tool' }, async (extra) => {
    const result = await (
      payment.session({ amount: '1', suggestedDeposit: '5', unitType: 'tool-call' }) as (
        input: unknown,
      ) => Promise<any>
    )(extra)
    if (result.status === 402) throw result.challenge

    return (result as { withReceipt: (response: unknown) => unknown }).withReceipt({
      content: [{ type: 'text' as const, text: 'session tool executed' }],
    }) as never
  })

  mcpServer.registerTool(
    'session_tool_double',
    { description: 'Session metered tool charging two units' },
    async (extra) => {
      const result = await (
        payment.session({ amount: '2', suggestedDeposit: '5', unitType: 'tool-call' }) as (
          input: unknown,
        ) => Promise<any>
      )(extra)
      if (result.status === 402) throw result.challenge

      return (result as { withReceipt: (response: unknown) => unknown }).withReceipt({
        content: [{ type: 'text' as const, text: 'session double tool executed' }],
      }) as never
    },
  )

  const app = createMcpExpressApp()
  const serverTransport = new StreamableHTTPServerTransport({
    sessionIdGenerator: randomUUID,
  })

  await mcpServer.connect(serverTransport as never)

  app.all('/mcp', (req, res) => {
    void (async () => {
      try {
        await serverTransport.handleRequest(req, res, req.body)
      } catch (error) {
        console.error('MCP integration route failed', error)
        if (!res.headersSent) res.status(500).json({ error: String(error) })
      }
    })()
  })

  const httpServer = await createMcpHttpServer(app)
  const sdkClient = new Client({ name: 'test-client', version: '1.0.0' })
  const clientTransport = new StreamableHTTPClientTransport(new URL(`${httpServer.url}/mcp`))
  await sdkClient.connect(clientTransport as never)

  const mcp = McpClient.wrap(sdkClient, {
    methods: [chargeMethod, sessionMethod],
  })

  return {
    async close() {
      httpServer.close()
      await Promise.allSettled([sdkClient.close(), mcpServer.close(), serverTransport.close()])
    },
    mcp,
    sdkClient,
    sessionMethod,
    sessionStore,
  }
}

async function getPaymentChallenge(client: Client, toolName: string): Promise<SessionChallenge> {
  try {
    await client.callTool({ name: toolName, arguments: {} })
  } catch (error) {
    if (!McpClient.isPaymentRequiredError(error)) throw error

    const challenge = error.data.challenges.find(
      (challenge) => challenge.method === 'tempo' && challenge.intent === 'session',
    )
    if (!challenge)
      throw new Error(`No tempo.session challenge returned for ${toolName}`, { cause: error })
    return challenge as SessionChallenge
  }

  throw new Error(`Expected ${toolName} to require payment`)
}

async function callToolWithCredential(
  client: Client,
  toolName: string,
  serializedCredential: string,
): Promise<McpClient.CallToolResult> {
  const result = await client.callTool({
    name: toolName,
    arguments: {},
    _meta: {
      [core_Mcp.credentialMetaKey]: Credential.deserialize(serializedCredential),
    },
  })

  return {
    ...result,
    receipt: result._meta?.[core_Mcp.receiptMetaKey] as McpClient.CallToolResult['receipt'],
  }
}

async function getPaymentRequiredError(
  client: Client,
  toolName: string,
  serializedCredential: string,
): Promise<PaymentRequiredMcpError> {
  try {
    await callToolWithCredential(client, toolName, serializedCredential)
  } catch (error) {
    if (!McpClient.isPaymentRequiredError(error)) throw error
    return error as unknown as PaymentRequiredMcpError
  }

  throw new Error(`Expected ${toolName} to return a payment-required error`)
}

async function getTokenBalance(account: Address): Promise<bigint> {
  return readContract(
    testClient,
    Actions.token.getBalance.call({ account, token: asset }) as never,
  ) as Promise<bigint>
}

async function createMcpHttpServer(handler: http.RequestListener) {
  const server = http.createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const { port } = server.address() as { port: number }

  return {
    close() {
      server.closeAllConnections?.()
      server.closeIdleConnections?.()
      server.close(() => {})
    },
    url: `http://127.0.0.1:${port}`,
  }
}
