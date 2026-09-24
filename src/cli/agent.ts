const agentSignals = [
  ['ANTIGRAVITY_CLI_ALIAS', 'antigravity'],
  ['CLAUDECODE', 'claude_code'],
  ['CLINE_ACTIVE', 'cline'],
  ['CODEX_SANDBOX', 'codex_cli'],
  ['CODEX_THREAD_ID', 'codex_cli'],
  ['CODEX_SANDBOX_NETWORK_DISABLED', 'codex_cli'],
  ['CODEX_CI', 'codex_cli'],
  ['CURSOR_AGENT', 'cursor'],
  ['GEMINI_CLI', 'gemini_cli'],
  ['OPENCODE', 'open_code'],
  ['OPENCLAW_SHELL', 'openclaw'],
  ['CLAUDE_CODE_ENTRYPOINT', 'claude_code'],
  ['CODEX_INTERNAL_ORIGINATOR_OVERRIDE', 'codex_cli'],
] as const

/** Returns the first recognized AI agent in signal priority order. */
export function detectAgent(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return agentSignals.find(([variable]) => env[variable])?.[1]
}
