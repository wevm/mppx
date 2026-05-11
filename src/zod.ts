import { type ZodMiniOptional, type ZodMiniType, z } from 'zod/mini'

export * from 'zod/mini'

export type DatetimeInput = string | Date

/** Numeric string amount (e.g., "1", "1.5", "1000000"). */
export function amount() {
  return z.string().check(z.regex(/^\d+(\.\d+)?$/, 'Invalid amount'))
}

/** ISO 8601 datetime string (e.g., "2025-01-06T12:00:00Z"). */
export function datetime() {
  return z
    .string()
    .check(
      z.regex(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/,
        'Invalid ISO 8601 datetime',
      ),
    )
}

/** ISO 8601 datetime string or Date object, transformed to a Date. */
export function datetimeInput(message = 'Invalid ISO 8601 datetime') {
  return z
    .pipe(
      z.union([datetime(), z.custom<Date>((value) => value instanceof Date)]),
      z.transform(toDate),
    )
    .check(z.refine((value) => Number.isFinite(value.getTime()), message))
}

/** Converts an ISO 8601 datetime string or Date object to a Date. */
export function toDate(value: DatetimeInput): Date {
  return value instanceof Date ? value : new Date(value)
}

/** Serializes an ISO 8601 datetime string or Date object for wire output. */
export function toDatetimeString(value: DatetimeInput): string {
  if (!(value instanceof Date)) return value
  if (!Number.isFinite(value.getTime())) return 'Invalid Date'
  return value.toISOString()
}

/** Hex-encoded address string (0x-prefixed, 40 hex chars). */
export function address() {
  return z.string().check(z.regex(/^0x[0-9a-fA-F]{40}$/, 'Invalid address'))
}

/** Hex-encoded hash string (0x-prefixed, 64 hex chars). */
export function hash() {
  return z.string().check(z.regex(/^0x[0-9a-fA-F]{64}$/, 'Invalid hash'))
}

/** Billing period: "day", "week", "month", "year", or seconds as string. */
export function period() {
  return z.string().check(z.regex(/^(day|week|month|year|\d+)$/, 'Invalid period'))
}

/** Hex-encoded signature string (0x-prefixed). */
export function signature() {
  return z.string().check(z.regex(/^0x[0-9a-fA-F]+$/, 'Invalid signature'))
}

/** Checks if a schema is optional and returns the inner type if so. */
export function unwrapOptional<schema extends ZodMiniType>(schema: schema): ZodMiniType {
  if (schema._zod.def.type === 'optional')
    return (schema as unknown as ZodMiniOptional)._zod.def.innerType as ZodMiniType
  return schema
}
