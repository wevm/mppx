import { describe, expect, test } from 'vp/test'

import { detectAgent } from './agent.js'

describe('detectAgent', () => {
  test.each([
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
  ])('detects %s as %s', (variable, agent) => {
    expect(detectAgent({ [variable]: '1' })).toBe(agent)
  })

  test('ignores empty and unknown signals', () => {
    expect(detectAgent({ CLAUDECODE: '', UNKNOWN_AGENT: '1' })).toBeUndefined()
  })

  test('returns the first matching agent', () => {
    expect(detectAgent({ CLAUDECODE: '1', CURSOR_AGENT: '1' })).toBe('claude_code')
  })
})
