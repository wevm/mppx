/**
 * Suites sharing the funded Tempo accounts. Keep these serial within each shard.
 * Values are summed test durations (ms), refreshed weekly by the Rebalance Test
 * Shards workflow from successful main CI reports. Membership is maintained
 * manually because it determines which suites need shared chain fixtures.
 */
export const tempoSuites: Record<string, number> = {
  'src/cli/cli.test.ts': 5465,
  'src/client/Mppx.test.ts': 687,
  'src/client/internal/Fetch.test.ts': 1456,
  'src/mcp/client/McpClient.integration.test.ts': 5005,
  'src/mcp/client/McpClient.test.ts': 340,
  'src/middlewares/elysia.test.ts': 960,
  'src/middlewares/express.test.ts': 1733,
  'src/middlewares/hono.test.ts': 1364,
  'src/middlewares/nextjs.test.ts': 1104,
  'src/proxy/Proxy.test.ts': 3153,
  'src/proxy/services/anthropic.test.ts': 166,
  'src/proxy/services/openai.test.ts': 67,
  'src/proxy/services/stripe.test.ts': 257,
  'src/server/Methods.test.ts': 29,
  'src/server/Mppx.test.ts': 1743,
  'src/tempo/AccessKeyAuthorization.test.ts': 97,
  'src/tempo/internal/fee-token.test.ts': 2213,
  'src/tempo/legacy/AccessKeyAuthorization.test.ts': 1193,
  'src/tempo/legacy/client/ChannelOps.test.ts': 479,
  'src/tempo/legacy/client/Session.test.ts': 464,
  'src/tempo/legacy/session/Chain.test.ts': 9404,
  'src/tempo/server/Charge.test.ts': 34952,
  'src/tempo/session/precompile/Chain.integration.test.ts': 4815,
  'src/tempo/session/server/MachineToken.integration.test.ts': 3000,
  'src/tempo/session/server/Session.integration.test.ts': 7743,
  'src/x402/Exact.e2e.test.ts': 108,
}
