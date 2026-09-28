/**
 * Suites sharing the funded Tempo accounts. Keep these serial within each shard.
 * Values are summed test durations (ms) from CI run 36450981124, used to balance
 * shards rather than splitting by file count. Refresh from verbose test logs
 * when the integration suite changes substantially.
 */
export const tempoSuites: Record<string, number> = {
  'src/cli/cli.test.ts': 5431,
  'src/client/Mppx.test.ts': 657,
  'src/client/internal/Fetch.test.ts': 1338,
  'src/mcp/client/McpClient.integration.test.ts': 5473,
  'src/mcp/client/McpClient.test.ts': 444,
  'src/middlewares/elysia.test.ts': 1300,
  'src/middlewares/express.test.ts': 1688,
  'src/middlewares/hono.test.ts': 1249,
  'src/middlewares/nextjs.test.ts': 1342,
  'src/proxy/Proxy.test.ts': 3121,
  'src/proxy/services/anthropic.test.ts': 236,
  'src/proxy/services/openai.test.ts': 55,
  'src/proxy/services/stripe.test.ts': 295,
  'src/server/Methods.test.ts': 26,
  'src/server/Mppx.test.ts': 2130,
  'src/tempo/AccessKeyAuthorization.test.ts': 257,
  'src/tempo/internal/fee-token.test.ts': 2168,
  'src/tempo/legacy/AccessKeyAuthorization.test.ts': 3058,
  'src/tempo/legacy/client/ChannelOps.test.ts': 482,
  'src/tempo/legacy/client/Session.test.ts': 507,
  'src/tempo/legacy/session/Chain.test.ts': 9402,
  'src/tempo/server/Charge.test.ts': 33618,
  'src/tempo/session/precompile/Chain.integration.test.ts': 5138,
  'src/tempo/session/server/Session.integration.test.ts': 5584,
  'src/x402/Exact.e2e.test.ts': 169,
}
