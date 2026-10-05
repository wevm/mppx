/**
 * Suites sharing the funded Tempo accounts. Keep these serial within each shard.
 * Values are summed test durations (ms), refreshed weekly by the Rebalance Test
 * Shards workflow from successful main CI reports. Membership is maintained
 * manually because it determines which suites need shared chain fixtures.
 */
export const tempoSuites: Record<string, number> = {
  'src/cli/cli.test.ts': 5287,
  'src/client/Mppx.test.ts': 645,
  'src/client/internal/Fetch.test.ts': 1397,
  'src/mcp/client/McpClient.integration.test.ts': 5468,
  'src/mcp/client/McpClient.test.ts': 413,
  'src/middlewares/elysia.test.ts': 1186,
  'src/middlewares/express.test.ts': 1634,
  'src/middlewares/hono.test.ts': 1330,
  'src/middlewares/nextjs.test.ts': 1205,
  'src/proxy/Proxy.test.ts': 3083,
  'src/proxy/services/anthropic.test.ts': 275,
  'src/proxy/services/openai.test.ts': 48,
  'src/proxy/services/stripe.test.ts': 165,
  'src/server/Methods.test.ts': 30,
  'src/server/Mppx.test.ts': 1924,
  'src/tempo/AccessKeyAuthorization.test.ts': 273,
  'src/tempo/internal/fee-token.test.ts': 2142,
  'src/tempo/legacy/AccessKeyAuthorization.test.ts': 3117,
  'src/tempo/legacy/client/ChannelOps.test.ts': 476,
  'src/tempo/legacy/client/Session.test.ts': 521,
  'src/tempo/legacy/session/Chain.test.ts': 9404,
  'src/tempo/server/Charge.test.ts': 34215,
  'src/tempo/session/precompile/Chain.integration.test.ts': 4943,
  'src/tempo/session/server/Session.integration.test.ts': 5565,
  'src/x402/Exact.e2e.test.ts': 167,
}
