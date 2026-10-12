/**
 * Suites sharing the funded Tempo accounts. Keep these serial within each shard.
 * Values are summed test durations (ms), refreshed weekly by the Rebalance Test
 * Shards workflow from successful main CI reports. Membership is maintained
 * manually because it determines which suites need shared chain fixtures.
 */
export const tempoSuites: Record<string, number> = {
  'src/cli/cli.test.ts': 5332,
  'src/client/Mppx.test.ts': 646,
  'src/client/internal/Fetch.test.ts': 1495,
  'src/mcp/client/McpClient.integration.test.ts': 5464,
  'src/mcp/client/McpClient.test.ts': 509,
  'src/middlewares/elysia.test.ts': 1199,
  'src/middlewares/express.test.ts': 1564,
  'src/middlewares/hono.test.ts': 1317,
  'src/middlewares/nextjs.test.ts': 1225,
  'src/proxy/Proxy.test.ts': 3201,
  'src/proxy/services/anthropic.test.ts': 276,
  'src/proxy/services/openai.test.ts': 48,
  'src/proxy/services/stripe.test.ts': 193,
  'src/server/Methods.test.ts': 27,
  'src/server/Mppx.test.ts': 1935,
  'src/tempo/AccessKeyAuthorization.test.ts': 144,
  'src/tempo/internal/fee-token.test.ts': 2239,
  'src/tempo/legacy/AccessKeyAuthorization.test.ts': 3132,
  'src/tempo/legacy/client/ChannelOps.test.ts': 475,
  'src/tempo/legacy/client/Session.test.ts': 507,
  'src/tempo/legacy/session/Chain.test.ts': 9403,
  'src/tempo/server/Charge.test.ts': 34488,
  'src/tempo/session/precompile/Chain.integration.test.ts': 5171,
  'src/tempo/session/server/Session.integration.test.ts': 7126,
  'src/x402/Exact.e2e.test.ts': 163,
}
