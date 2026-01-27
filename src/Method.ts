import type * as Challenge from './Challenge.js'
import type * as Credential from './Credential.js'
import type * as MethodIntent from './MethodIntent.js'
import type * as Receipt from './Receipt.js'
import type * as z from './zod.js'

/**
 * A payment method definition.
 *
 * Methods encapsulate:
 * - Method name (e.g., "tempo", "stripe")
 * - Supported intents (e.g., charge, authorize)
 */
export type Method<
  name extends string = string,
  intents extends Record<string, MethodIntent.MethodIntent> = Record<
    string,
    MethodIntent.MethodIntent
  >,
> = {
  /** Map of intent names to method intents. */
  intents: intents
  /** Payment method name (e.g., "tempo", "stripe"). */
  name: name
}
export type AnyMethod = Method<any, any>

/**
 * A client-side payment method with credential creation logic.
 *
 * Extends the base Method with:
 * - Optional per-request context schema
 * - Credential creation logic
 */
export type Client<
  name extends string = string,
  intents extends Record<string, MethodIntent.MethodIntent> = Record<
    string,
    MethodIntent.MethodIntent
  >,
  context extends z.ZodMiniType | undefined = z.ZodMiniType | undefined,
> = Method<name, intents> & {
  /** Schema for per-request context passed to `createCredential`. */
  context?: context
  /** Create a credential from a challenge. */
  createCredential: CreateCredentialFn<
    intents,
    context extends z.ZodMiniType ? z.output<context> : Record<never, never>
  >
}
export type AnyClient = Client<any, any, any>

/**
 * A server-side payment method with verification logic.
 *
 * Extends the base Method with:
 * - Optional per-request context schema
 * - Verification logic
 */
export type Server<
  name extends string = string,
  intents extends Record<string, MethodIntent.MethodIntent> = Record<
    string,
    MethodIntent.MethodIntent
  >,
  context extends z.ZodMiniType | undefined = z.ZodMiniType | undefined,
> = Method<name, intents> & {
  /** Schema for per-request context passed to `verify`. */
  context?: context
  /** Transform request before challenge creation. */
  request?: RequestFn<
    intents,
    context extends z.ZodMiniType ? z.output<context> : Record<never, never>
  >
  /** Verify a credential and return a receipt. */
  verify: VerifyFn<
    intents,
    context extends z.ZodMiniType ? z.output<context> : Record<never, never>
  >
}
export type AnyServer = Server<any, any, any>

/** Credential creation function that produces a serialized credential from a challenge. */
export type CreateCredentialFn<
  intents extends Record<string, MethodIntent.MethodIntent>,
  context = unknown,
> = (parameters: CreateCredentialFn.Parameters<intents, context>) => Promise<string>

export declare namespace CreateCredentialFn {
  type Parameters<intents extends Record<string, MethodIntent.MethodIntent>, context = unknown> = {
    [key in keyof intents]: {
      challenge: Challenge.Challenge<
        z.output<intents[key]['schema']['request']>,
        intents[key]['name']
      >
    } & ([keyof context] extends [never] ? unknown : { context: context })
  }[keyof intents]
}

/** Function that transforms request based on context. */
export type RequestFn<
  intents extends Record<string, MethodIntent.MethodIntent>,
  context = unknown,
> = (
  parameters: RequestFn.Parameters<intents, context>,
) => RequestFn.Parameters<intents, context>['request']

export declare namespace RequestFn {
  type Parameters<intents extends Record<string, MethodIntent.MethodIntent>, context = unknown> = {
    [key in keyof intents]: {
      description?: string | undefined
      expires?: string | undefined
      request: z.input<intents[key]['schema']['request']>
    } & ([keyof context] extends [never] ? unknown : context)
  }[keyof intents]
}

/** Verification function that validates a credential and returns a receipt. */
export type VerifyFn<
  intents extends Record<string, MethodIntent.MethodIntent>,
  context = unknown,
> = (parameters: VerifyFn.Parameters<intents, context>) => Promise<Receipt.Receipt>

export declare namespace VerifyFn {
  type Parameters<intents extends Record<string, MethodIntent.MethodIntent>, context = unknown> = {
    [key in keyof intents]: {
      context: context
      credential: Credential.Credential<
        z.output<intents[key]['schema']['credential']['payload']>,
        Challenge.Challenge<z.output<intents[key]['schema']['request']>, intents[key]['name']>
      >
      request: globalThis.Request
    }
  }[keyof intents]
}

/** Extract context input type from a Client Method (for createCredential options). */
export type ClientContextOf<method extends AnyClient> =
  NonNullable<method['context']> extends never
    ? Record<never, never>
    : NonNullable<z.input<NonNullable<method['context']>>>

/** Extract context input type from a Server Method (for IntentFn options). */
export type ContextOf<method extends AnyServer> =
  NonNullable<method['context']> extends never
    ? Record<never, never>
    : NonNullable<z.input<NonNullable<method['context']>>>

/** Extract name from a Method */
export type NameOf<method extends AnyMethod> = method['name']

/** Extract intents from a Method */
export type IntentsOf<method extends AnyMethod> = method['intents']

/**
 * Creates a payment method from parameters.
 *
 * @example
 * ```ts
 * import { Method } from 'mpay'
 *
 * const method = Method.from({
 *   name: 'custom',
 *   intents: { charge: Intents.charge },
 * })
 * ```
 */
export function from<
  const name extends string,
  const intents extends Record<string, MethodIntent.MethodIntent>,
>(parameters: from.Parameters<name, intents>): Method<name, intents> {
  return {
    intents: parameters.intents,
    name: parameters.name,
  }
}

export declare namespace from {
  type Parameters<
    name extends string,
    intents extends Record<string, MethodIntent.MethodIntent>,
  > = {
    /** Map of intent names to method intents. */
    intents: intents
    /** Payment method name (e.g., "tempo", "stripe"). */
    name: name
  }
}

/**
 * Extends a method with server-side verification logic.
 *
 * @example
 * ```ts
 * import { Method, tempo } from 'mpay'
 *
 * const method = Method.toServer(tempo, {
 *   async verify({ credential }) {
 *     // verification logic
 *     return { status: 'success', ... }
 *   },
 * })
 * ```
 */
export function toServer<
  const method extends Method,
  const context extends z.ZodMiniType | undefined = undefined,
>(
  method: method,
  options: toServer.Options<method['intents'], context>,
): Server<method['name'], method['intents'], context> {
  const { context, request, verify } = options
  const { intents, name } = method
  return {
    context,
    intents,
    name,
    request,
    verify,
  } as Server<method['name'], method['intents'], context>
}

export declare namespace toServer {
  type Options<
    intents extends Record<string, MethodIntent.MethodIntent>,
    context extends z.ZodMiniType | undefined = undefined,
  > = {
    /** Schema for per-request context passed to `verify`. */
    context?: context
    /** Transform request before challenge creation. */
    request?: RequestFn<
      intents,
      context extends z.ZodMiniType ? z.output<context> : Record<never, never>
    >
    /** Verify a credential and return a receipt. */
    verify: VerifyFn<
      intents,
      context extends z.ZodMiniType ? z.output<context> : Record<never, never>
    >
  }
}

/**
 * Extends a method with client-side credential creation logic.
 *
 * @example
 * ```ts
 * import { Method, tempo } from 'mpay'
 *
 * const method = Method.toClient(tempo, {
 *   async createCredential({ challenge }) {
 *     // sign and create credential
 *     return Credential.serialize({ challenge, payload: { ... } })
 *   },
 * })
 * ```
 */
export function toClient<
  const method extends Method,
  const context extends z.ZodMiniType | undefined = undefined,
>(
  method: method,
  options: toClient.Options<method['intents'], context>,
): Client<method['name'], method['intents'], context> {
  const { context, createCredential } = options
  const { intents, name } = method
  return {
    context,
    createCredential,
    intents,
    name,
  } as Client<method['name'], method['intents'], context>
}

export declare namespace toClient {
  type Options<
    intents extends Record<string, MethodIntent.MethodIntent>,
    context extends z.ZodMiniType | undefined = undefined,
  > = {
    /** Schema for per-request context passed to `createCredential`. */
    context?: context
    /** Create a credential from a challenge. */
    createCredential: CreateCredentialFn<
      intents,
      context extends z.ZodMiniType ? z.output<context> : Record<never, never>
    >
  }
}
