// Writes the fortune: a haiku from a small model, shaped by what the caller proved.
//
// Only verified identity reaches the prompt: nothing for an anonymous caller, a first
// name and domain from a verified email, and the member table's row for a member.
import type { Profile } from './tiers.js'
import type { Trace } from './trace.js'

export type Env = {
  /** Workers AI binding. */
  AI?: { run(model: string, input: unknown): Promise<unknown> } | undefined
  /** Fallback model provider for local development without a Cloudflare login. */
  ANTHROPIC_API_KEY?: string | undefined
  /** Anthropic API base URL. @default https://api.anthropic.com */
  ANTHROPIC_BASE_URL?: string | undefined
}

/** Workers AI model: small and fast. */
export const model = '@cf/meta/llama-3.2-3b-instruct'

const themes = [
  'tides',
  'lanterns',
  'trains',
  'rain',
  'mountains',
  'kites',
  'moss',
  'stars',
  'ink',
  'bridges',
]

/** Builds the prompt for a caller's profile. */
export function prompt(profile: Profile): { system: string; user: string } {
  const theme = themes[Math.floor(Math.random() * themes.length)]
  const system = [
    'You are a fortune cookie oracle.',
    'Reply with exactly one haiku: three lines of 5, 7 and 5 syllables.',
    'No title, no quotes, no explanation. Make it a hopeful prediction.',
  ].join(' ')
  // step: fortune.prompt
  const who =
    profile.kind === 'member'
      ? `${profile.name}, a ${profile.role} on the ${profile.team} team. Weave in an inside joke about payments, blocks or stablecoins.`
      : profile.kind === 'email'
        ? `${profile.name}, who works at ${profile.domain}. Mention their name.`
        : 'a stranger who revealed nothing about themselves. Keep it mysterious.'
  return { system, user: `Write a fortune for ${who} Use imagery of ${theme}.` }
}

/** Writes a haiku, retrying once when the syllables are off. */
export async function write(
  profile: Profile,
  parameters: { env: Env; trace: Trace },
): Promise<{ lines: string[]; prompt: { system: string; user: string }; model: string }> {
  const { env, trace } = parameters
  const input = prompt(profile)
  trace.step('fortune.prompt', input.user)
  let best: { lines: string[]; model: string } | undefined
  for (let attempt = 0; attempt < 2; attempt++) {
    // step: fortune.llm
    const result = await generate(input, env)
    const lines = parse(result.text)
    trace.step('fortune.llm', `${result.model}: ${lines.map(syllables).join('-')} syllables`)
    if (lines.length === 3 && (!best || score(lines) < score(best.lines)))
      best = { ...result, lines }
    if (best && score(best.lines) <= 1) break
  }
  return { ...(best ?? fallback()), prompt: input }
}

async function generate(input: { system: string; user: string }, env: Env) {
  const messages = [
    { role: 'system', content: input.system },
    { role: 'user', content: input.user },
  ]
  if (env.AI) {
    const result = (await env.AI.run(model, { messages, max_tokens: 80, temperature: 0.9 })) as {
      response?: string
    }
    return { model, text: result.response ?? '' }
  }
  if (env.ANTHROPIC_API_KEY) {
    const response = await fetch(
      `${env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com'}/v1/messages`,
      {
        method: 'POST',
        headers: {
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5',
          max_tokens: 80,
          system: input.system,
          messages: [{ role: 'user', content: input.user }],
        }),
      },
    )
    const body = (await response.json()) as { content?: { text?: string }[] }
    return { model: 'claude-haiku-4-5', text: body.content?.[0]?.text ?? '' }
  }
  const { lines } = fallback()
  return { model: 'built-in', text: lines.join('\n') }
}

function fallback() {
  return {
    model: 'built-in',
    lines: ['A coin finds its way', 'through the quiet ledger night', 'morning brings a match'],
  }
}

/** The haiku's lines: the first three non-empty ones, without numbering or quotes. */
function parse(text: string): string[] {
  return text
    .split('\n')
    .map((line) =>
      line
        .replace(/^[\s\d.)*-]+/, '')
        .replace(/["“”]/g, '')
        .trim(),
    )
    .filter((line) => line && !/^(here|haiku|fortune)\b.*:$/i.test(line))
    .slice(0, 3)
}

/** Total syllables off from 5-7-5. */
function score(lines: string[]) {
  return [5, 7, 5].reduce(
    (total, target, i) => total + Math.abs(syllables(lines[i] ?? '') - target),
    0,
  )
}

/** Rough English syllable count: vowel groups, less a silent final e. */
export function syllables(line: string): number {
  return line
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean)
    .reduce((total, word) => {
      const groups = word.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '').match(/[aeiouy]{1,2}/g)
      return total + Math.max(1, groups?.length ?? 0)
    }, 0)
}
