/**
 * Suites sharing the funded Tempo accounts. Keep these serial within each shard.
 * Values are summed test durations (ms), refreshed weekly by the Rebalance Test
 * Shards workflow from successful main CI reports. Membership is maintained
 * manually because it determines which suites need shared chain fixtures.
 */
export const tempoSuites: Record<string, number> = {
  'src/cli/cli.test.ts': 5396,
  'src/client/Mppx.test.ts': 789,
  'src/client/internal/Fetch.test.ts': 1490,
  'src/mcp/client/McpClient.integration.test.ts': 5423,
  'src/mcp/client/McpClient.test.ts': 444,
  'src/middlewares/elysia.test.ts': 1330,
  'src/middlewares/express.test.ts': 1605,
  'src/middlewares/hono.test.ts': 1007,
  'src/middlewares/nextjs.test.ts': 1006,
  'src/proxy/Proxy.test.ts': 2908,
  'src/proxy/services/anthropic.test.ts': 285,
  'src/proxy/services/openai.test.ts': 40,
  'src/proxy/services/stripe.test.ts': 151,
  'src/server/Methods.test.ts': 37,
  'src/server/Mppx.test.ts': 1961,
  'src/tempo/AccessKeyAuthorization.test.ts': 114,
  'src/tempo/internal/fee-token.test.ts': 2143,
  'src/tempo/legacy/AccessKeyAuthorization.test.ts': 1042,
  'src/tempo/legacy/client/ChannelOps.test.ts': 460,
  'src/tempo/legacy/client/Session.test.ts': 475,
  'src/tempo/legacy/session/Chain.test.ts': 9402,
  'src/tempo/server/Charge.test.ts': 34952,
  'src/tempo/session/precompile/Chain.integration.test.ts': 4876,
  'src/tempo/session/server/Session.integration.test.ts': 8587,
  'src/x402/Exact.e2e.test.ts': 165,
}
