import type * as Challenge from '../Challenge.js'

type MethodLike = {
  intent: string
  name: string
}

/** Typed `method/intent` key for a configured payment capability. */
export type Key<methods extends readonly MethodLike[]> = methods[number] extends infer mi
  ? mi extends { name: infer name extends string; intent: infer intent extends string }
    ? `${name}/${intent}`
    : never
  : never

/** Method keys grouped by method name for ergonomic config callbacks. */
export type KeyTree<methods extends readonly MethodLike[]> = {
  [name in methods[number]['name']]: {
    [mi in Extract<
      methods[number],
      { name: name }
    > as mi['intent']]: `${mi['name']}/${mi['intent']}`
  }
}

/** Per-capability q-values keyed by typed `method/intent` strings. */
export type Definition<methods extends readonly MethodLike[]> = Partial<
  Record<Key<methods>, number>
>

/**
 * Accept-Payment configuration.
 *
 * Callers may provide a plain definition map or a callback that receives a
 * typed key tree for authoring preferences without string literals.
 */
export type Config<methods extends readonly MethodLike[]> =
  | Definition<methods>
  | ((keys: KeyTree<methods>) => Definition<methods>)

/** Parsed Accept-Payment entry with its original declaration order. */
export type Entry = {
  intent: string | '*'
  method: string | '*'
  q: number
  index: number
}

/** Resolved negotiation data derived from client methods and config. */
export type Resolved<methods extends readonly MethodLike[]> = {
  definition: Definition<methods>
  entries: Entry[]
  header: string
  keys: KeyTree<methods>
}

type Match = Entry & { specificity: number }

/** Builds the typed key tree used by callback-style preference config. */
export function buildKeys<const methods extends readonly MethodLike[]>(
  methods: methods,
): KeyTree<methods> {
  const keys: Record<string, Record<string, string>> = {}

  for (const method of methods) {
    const group = (keys[method.name] ??= {})
    group[method.intent] = keyOf(method)
  }

  return keys as KeyTree<methods>
}

/** Resolves configured payment preferences into a header string and parsed entries. */
export function resolve<const methods extends readonly MethodLike[]>(
  methods: methods,
  config?: Config<methods>,
): Resolved<methods> {
  const keys = buildKeys(methods)
  const definition = resolveDefinition(methods, keys, config)
  const entries = methods.map((method, index) => ({
    intent: method.intent,
    method: method.name,
    q: definition[keyOf(method) as Key<methods>] ?? 1,
    index,
  }))

  return {
    definition,
    entries,
    header: serialize(entries),
    keys,
  }
}

/** Parses an `Accept-Payment` header into normalized preference entries. */
export function parse(header: string): Entry[] {
  const parts = header
    .split(/\s*,\s*/)
    .map((part) => part.trim())
    .filter(Boolean)

  if (parts.length === 0) throw new Error('Accept-Payment header is empty.')

  return parts.map((part, index) => parseEntry(part, index))
}

/** Serializes preference entries to an `Accept-Payment` header value. */
export function serialize(entries: readonly Omit<Entry, 'index'>[] | readonly Entry[]): string {
  return entries
    .map(({ method, intent, q }) => {
      const value = `${method}/${intent}`
      return q === 1 ? value : `${value};q=${formatQ(q)}`
    })
    .join(', ')
}

/**
 * Orders offered payment methods by the best matching client preference.
 *
 * More specific matches win before comparing q-values, so an explicit opt-out
 * like `tempo/charge;q=0` overrides a broader wildcard such as `tempo/*;q=1`.
 */
export function rank<const offer extends { intent: string; method: string }>(
  offers: readonly offer[],
  preferences: readonly Entry[],
): offer[] {
  return offers
    .map((offer, index) => {
      const match = bestMatch(offer, preferences)
      return match && match.q > 0 ? { match, offer, index } : undefined
    })
    .filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate))
    .sort((left, right) => right.match.q - left.match.q || left.index - right.index)
    .map(({ offer }) => offer)
}

/** Selects the best supported challenge from a set of server offers. */
export function selectChallenge<const methods extends readonly MethodLike[]>(
  challenges: readonly Challenge.Challenge[],
  methods: methods,
  preferences: readonly Entry[],
):
  | {
      challenge: Challenge.Challenge
      method: methods[number]
    }
  | undefined {
  const methodByKey = new Map<string, methods[number]>()
  for (const method of methods) {
    const key = keyOf(method)
    if (!methodByKey.has(key)) methodByKey.set(key, method)
  }

  const ranked = rank(
    challenges.filter((challenge) => methodByKey.has(keyOf(challenge))),
    preferences,
  )
  const challenge = ranked[0]
  if (!challenge) return undefined

  return {
    challenge,
    method: methodByKey.get(keyOf(challenge))!,
  }
}

/** Returns the canonical `method/intent` key for a method or challenge-like value. */
export function keyOf(value: { intent: string; method?: string; name?: string }): string {
  const method = value.method ?? value.name
  if (!method) throw new Error('Missing payment method name.')
  return `${method}/${value.intent}`
}

function bestMatch(
  offer: { intent: string; method: string },
  preferences: readonly Entry[],
): Match | undefined {
  let best: Match | undefined

  for (const preference of preferences) {
    if (!matches(offer, preference)) continue

    const candidate = { ...preference, specificity: specificity(preference) }
    if (
      !best ||
      candidate.specificity > best.specificity ||
      (candidate.specificity === best.specificity && candidate.q > best.q) ||
      (candidate.specificity === best.specificity &&
        candidate.q === best.q &&
        candidate.index < best.index)
    ) {
      best = candidate
    }
  }

  return best
}

function matches(
  offer: { intent: string; method: string },
  preference: Pick<Entry, 'intent' | 'method'>,
): boolean {
  return (
    (preference.method === '*' || preference.method === offer.method) &&
    (preference.intent === '*' || preference.intent === offer.intent)
  )
}

function specificity(preference: Pick<Entry, 'intent' | 'method'>): number {
  return Number(preference.method !== '*') + Number(preference.intent !== '*')
}

function parseEntry(part: string, index: number): Entry {
  const match = /^(?<method>[^/;\s]+|\*)\s*\/\s*(?<intent>[^/;\s]+|\*)(?<params>(?:\s*;\s*.+)?)$/u.exec(
    part,
  )
  const method = match?.groups?.method
  const intent = match?.groups?.intent

  if (!method || !intent) {
    throw new Error(`Invalid Accept-Payment entry: ${part}`)
  }

  assertToken(method, 'method')
  assertToken(intent, 'intent')

  let q = 1
  for (const param of splitParameters(match.groups?.params)) {
    if (!param) continue

    const parameterMatch = /^(?<name>[A-Za-z0-9_-]+)\s*=\s*(?<value>\S+)$/u.exec(param)
    const name = parameterMatch?.groups?.name
    const rawValue = parameterMatch?.groups?.value

    if (!name || !rawValue) {
      throw new Error(`Invalid Accept-Payment parameter: ${param}`)
    }
    if (name !== 'q') continue
    q = parseHeaderQ(rawValue, `Accept-Payment entry "${part}"`)
  }

  return { intent, method, q, index }
}

function splitParameters(value?: string): string[] {
  return value ? value.split(/\s*;\s*/).filter(Boolean) : []
}

function resolveDefinition<const methods extends readonly MethodLike[]>(
  methods: methods,
  keys: KeyTree<methods>,
  config?: Config<methods>,
): Definition<methods> {
  if (!config) return {} as Definition<methods>

  const raw = typeof config === 'function' ? config(keys) : config
  const allowed = new Set(methods.map((method) => keyOf(method)))
  const normalized: Record<string, number> = {}

  for (const [key, value] of Object.entries(raw ?? {})) {
    if (!allowed.has(key)) {
      throw new Error(`Unknown payment preference "${key}". Available: ${[...allowed].join(', ')}`)
    }
    normalized[key] = parseQ(value, `payment preference "${key}"`)
  }

  return normalized as Definition<methods>
}

function parseQ(value: unknown, context: string): number {
  if (typeof value !== 'number' || Number.isNaN(value) || !Number.isFinite(value)) {
    throw new Error(`Invalid q-value for ${context}. Expected a finite number.`)
  }
  return assertQ(value, context)
}

function parseHeaderQ(value: string, context: string): number {
  if (!/^0(?:\.\d{0,3})?$|^1(?:\.0{0,3})?$/.test(value)) {
    throw new Error(`Invalid q-value for ${context}. Expected an HTTP qvalue.`)
  }
  return assertQ(Number(value), context)
}

function assertQ(value: number, context: string): number {
  if (value < 0 || value > 1) {
    throw new Error(`Invalid q-value for ${context}. Expected a value between 0 and 1.`)
  }
  const rounded = Math.round(value * 1000)
  if (Math.abs(value * 1000 - rounded) > 1e-9) {
    throw new Error(`Invalid q-value for ${context}. Expected at most 3 decimal places.`)
  }
  return rounded / 1000
}

function formatQ(value: number): string {
  return value
    .toFixed(3)
    .replace(/\.0+$/, '')
    .replace(/(\.\d*?)0+$/, '$1')
}

function assertToken(value: string, label: string): void {
  if (value !== '*' && !/^[a-z0-9-]+$/.test(value)) {
    throw new Error(`Invalid Accept-Payment ${label}: ${value}`)
  }
}
