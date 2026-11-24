/**
 * Suites sharing the funded Tempo accounts. Keep these serial within each shard.
 * Values are summed test durations (ms), refreshed weekly by the Rebalance Test
 * Shards workflow from successful main CI reports. Membership is maintained
 * manually because it determines which suites need shared chain fixtures.
 */
export const tempoSuites: Record<string, number> = {
  'src/cli/cli.test.ts': 5826,
  'src/client/Mppx.test.ts': 652,
  'src/client/internal/Fetch.test.ts': 1481,
  'src/extensions/identity/tempo/TempoId.localnet.test.ts': 179,
  'src/mcp/client/McpClient.integration.test.ts': 5447,
  'src/mcp/client/McpClient.test.ts': 417,
  'src/middlewares/elysia.test.ts': 1312,
  'src/middlewares/express.test.ts': 1502,
  'src/middlewares/hono.test.ts': 1149,
  'src/middlewares/nextjs.test.ts': 1004,
  'src/proxy/Proxy.test.ts': 3079,
  'src/proxy/services/anthropic.test.ts': 171,
  'src/proxy/services/openai.test.ts': 49,
  'src/proxy/services/stripe.test.ts': 155,
  'src/server/Methods.test.ts': 28,
  'src/server/Mppx.test.ts': 2159,
  'src/tempo/AccessKeyAuthorization.test.ts': 258,
  'src/tempo/internal/fee-token.test.ts': 2100,
  'src/tempo/legacy/AccessKeyAuthorization.test.ts': 1068,
  'src/tempo/legacy/client/ChannelOps.test.ts': 456,
  'src/tempo/legacy/client/Session.test.ts': 500,
  'src/tempo/legacy/session/Chain.test.ts': 9402,
  'src/tempo/server/Charge.test.ts': 35439,
  'src/tempo/session/precompile/Chain.integration.test.ts': 4289,
  'src/tempo/session/server/Session.integration.test.ts': 8615,
  'src/x402/Exact.e2e.test.ts': 185,
}
