/**
 * Suites sharing the funded Tempo accounts. Keep these serial within each shard.
 * Values are summed test durations (ms), refreshed weekly by the Rebalance Test
 * Shards workflow from successful main CI reports. Membership is maintained
 * manually because it determines which suites need shared chain fixtures.
 */
export const tempoSuites: Record<string, number> = {
  'src/cli/cli.test.ts': 5255,
  'src/client/Mppx.test.ts': 658,
  'src/client/internal/Fetch.test.ts': 1320,
  'src/extensions/identity/tempo/TempoId.localnet.test.ts': 254,
  'src/mcp/client/McpClient.integration.test.ts': 4994,
  'src/mcp/client/McpClient.test.ts': 294,
  'src/middlewares/elysia.test.ts': 944,
  'src/middlewares/express.test.ts': 1432,
  'src/middlewares/hono.test.ts': 1115,
  'src/middlewares/nextjs.test.ts': 954,
  'src/proxy/Proxy.test.ts': 2998,
  'src/proxy/services/anthropic.test.ts': 96,
  'src/proxy/services/openai.test.ts': 30,
  'src/proxy/services/stripe.test.ts': 118,
  'src/server/Methods.test.ts': 18,
  'src/server/Mppx.test.ts': 1692,
  'src/tempo/AccessKeyAuthorization.test.ts': 176,
  'src/tempo/MachineTokenOffer.test.ts': 2000,
  'src/tempo/internal/fee-token.test.ts': 2233,
  'src/tempo/legacy/AccessKeyAuthorization.test.ts': 1040,
  'src/tempo/legacy/client/ChannelOps.test.ts': 445,
  'src/tempo/legacy/client/Session.test.ts': 461,
  'src/tempo/legacy/session/Chain.test.ts': 9401,
  'src/tempo/server/Charge.test.ts': 35384,
  'src/tempo/session/precompile/Chain.integration.test.ts': 4813,
  'src/tempo/session/server/Session.integration.test.ts': 8364,
  'src/x402/Exact.e2e.test.ts': 113,
}
