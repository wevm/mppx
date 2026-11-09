import { isInnerList, parseList, serializeList, Token } from 'structured-headers'
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
