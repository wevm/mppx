import { isInnerList, parseList, serializeItem, serializeList, Token } from 'structured-headers'
import type { Item } from 'structured-headers'

import type * as Types from '../Types.js'

/** The response header in which a 402 lists the identities its payment check requires. */
export const header = 'Identity-Required'

/**
 * Serializes requirements as a structured-field list: each `type` token with an `issuer`
 * string parameter when set. Throws a `TypeError` for a type that is not a token.
 */
export function serialize(requirements: readonly Types.Requirement[]): string {
  return serializeList(
    requirements.map(
      ({ issuer, type }) =>
        [new Token(type), new Map(issuer === undefined ? [] : [['issuer', issuer]])] as Item,
    ),
  )
}

/** Parses an `Identity-Required` value, skipping members that are not requirements. */
export function parse(value: string | null): readonly Types.Requirement[] {
  if (!value) return []
  let list: ReturnType<typeof parseList>
  try {
    list = parseList(value)
  } catch {
    return []
  }
  const requirements: Types.Requirement[] = []
  for (const member of list) {
    if (isInnerList(member) || !(member[0] instanceof Token)) continue
    const issuer = member[1].get('issuer')
    requirements.push(
      Object.freeze({
        type: member[0].toString(),
        ...(typeof issuer === 'string' && { issuer }),
      }),
    )
  }
  return Object.freeze(requirements)
}

/**
 * Headers that list requirements as a structured-field list, whose values `anyOf` groups into
 * one inner list of alternatives. Lowercase, as `Headers` yields names.
 */
export const alternativeHeaders: readonly string[] = Object.freeze([
  'identity-attestation-required',
])

/**
 * Combines the values the rejected members of an `anyOf` sent in one requirements header:
 *
 * - Each value is one item or one inner list: their items, deduplicated, become one inner list
 *   of alternatives, any one of which meets it (a single item stays bare).
 * - Otherwise (a member lists several requirements, or a value is malformed): the values are
 *   kept as they are. Inner lists do not nest, so "a and b, or c" is sent as all three, and a
 *   client asks for more than the route needs, never less.
 */
export function alternatives(values: readonly string[]): string {
  const items: Item[] = []
  for (const value of values) {
    let list: ReturnType<typeof parseList>
    try {
      list = parseList(value)
    } catch {
      return values.join(', ')
    }
    const [member] = list
    if (list.length !== 1 || !member) return values.join(', ')
    items.push(...(isInnerList(member) ? member[0] : [member]))
  }
  const unique = [...new Map(items.map((item) => [serializeItem(item), item])).values()]
  return serializeList(unique.length === 1 ? unique : [[unique, new Map()]])
}

/** Returns the distinct requirements of several lists, in first-seen order. */
export function merge(
  lists: readonly (readonly Types.Requirement[])[],
): readonly Types.Requirement[] {
  const seen = new Map<string, Types.Requirement>()
  for (const requirement of lists.flat()) {
    const key = JSON.stringify([requirement.type, requirement.issuer ?? null])
    if (!seen.has(key)) seen.set(key, requirement)
  }
  return Object.freeze([...seen.values()])
}
