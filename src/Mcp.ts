import type * as Challenge from './Challenge.js'
import type * as Credential from './Credential.js'
import type { OneOf } from './internal/types.js'
import type * as core_Receipt from './Receipt.js'

/** MCP JSON-RPC error code for payment required. */
export const paymentRequiredCode = -32042

/** MCP JSON-RPC error code for payment verification failed. */
export const paymentVerificationFailedCode = -32043

/** MCP metadata key for credentials. */
export const credentialMetaKey = 'org.paymentauth/credential'

/** MCP metadata key for receipts. */
export const receiptMetaKey = 'org.paymentauth/receipt'

/**
 * MCP request with payment metadata support.
 */
export type Request = {
  jsonrpc: '2.0'
  id: number | string
  method: string
  params?: {
    _meta?: {
      [credentialMetaKey]?: Credential.Credential
      [key: string]: unknown
    }
    [key: string]: unknown
  }
}

/**
 * MCP result with optional receipt metadata.
 */
export type Result = {
  _meta?: {
    [receiptMetaKey]?: Receipt
    [key: string]: unknown
  }
  [key: string]: unknown
}

/**
 * MCP error object for payment required responses.
 */
export type ErrorObject = {
  code: number
  message: string
  data?: {
    httpStatus: 402
    challenges: Challenge.Challenge[]
  }
}

/**
 * MCP response (success or error).
 */
export type Response = {
  jsonrpc: '2.0'
  id: number | string | null
} & OneOf<{ result: Result } | { error: ErrorObject }>

/**
 * MCP receipt structure (extends Receipt with MCP-specific fields).
 */
export type Receipt = core_Receipt.Receipt & {
  challengeId: string
}
