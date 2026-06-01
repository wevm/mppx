import { getAddress, recoverTypedDataAddress } from 'viem'

import type * as Credential from '../../Credential.js'
import { VerificationFailedError } from '../../Errors.js'
import * as Method from '../../Method.js'
import * as Receipt from '../../Receipt.js'
import * as ServerTransport from '../../server/Transport.js'
import * as X402 from '../../x402/server/EvmCharge.js'
import * as Assets from '../Assets.js'
import * as Methods from '../Methods.js'
import * as Types from '../Types.js'

/**
 * Creates an EVM charge server method.
 *
 * Speaks the native Payment-auth `evm/charge` wire format.
 */
export function charge(
  parameters: charge.NativeConfig,
): Method.Server<typeof Methods.charge, charge.Defaults>
export function charge(parameters: charge.NativeConfig): Method.AnyServer {
  const config = resolveConfig(parameters)
  const paths = createPaths(config)
  const transport = httpTransport(paths)

  return Method.toServer<typeof Methods.charge, charge.Defaults, typeof transport>(Methods.charge, {
    defaults: {
      chainId: config.chainId,
      currency: config.currency,
      credentialTypes: ['authorization'],
      decimals: config.decimals,
      recipient: config.recipient,
    },
    transport,
    async verify({ credential }) {
      const payload = credential.payload as Types.AuthorizationPayload
      const request = credential.challenge.request as Types.ChargeRequest
      const chainId = request.methodDetails.chainId
      const isX402Credential = X402.isCredential(credential)

      if (!request.methodDetails.credentialTypes?.includes('authorization')) {
        throw new VerificationFailedError({
          reason: 'EVM authorization credentials are not supported for this challenge',
        })
      }

      if (request.methodDetails.splits?.length) {
        throw new VerificationFailedError({
          reason: 'EVM authorization credentials do not support splits',
        })
      }

      assertAddressEqual(payload.to, request.recipient, 'EVM authorization recipient mismatch')
      if (payload.value !== request.amount)
        throw new VerificationFailedError({ reason: 'EVM authorization amount mismatch' })
      if (!isX402Credential && payload.nonce !== Types.challengeHash(credential.challenge))
        throw new VerificationFailedError({ reason: 'EVM authorization challenge hash mismatch' })
      const now = BigInt(Math.floor(Date.now() / 1000))
      if (BigInt(payload.validAfter) > now)
        throw new VerificationFailedError({ reason: 'EVM authorization is not valid yet' })
      if (BigInt(payload.validBefore) <= now)
        throw new VerificationFailedError({ reason: 'EVM authorization has expired' })

      const signer = await recoverTypedDataAddress({
        domain: Types.authorizationDomain({
          authorization: config.authorization,
          chainId,
          currency: request.currency as `0x${string}`,
        }),
        message: {
          from: getAddress(payload.from),
          nonce: payload.nonce as `0x${string}`,
          to: getAddress(payload.to),
          validAfter: BigInt(payload.validAfter),
          validBefore: BigInt(payload.validBefore),
          value: BigInt(payload.value),
        },
        primaryType: 'TransferWithAuthorization',
        signature: payload.signature as `0x${string}`,
        types: Types.authorizationTypes,
      })
      assertAddressEqual(signer, payload.from, 'EVM authorization signature mismatch')

      const source = Types.toSource({ address: getAddress(payload.from), chainId })
      if (credential.source && credential.source !== source) {
        throw new VerificationFailedError({ reason: 'EVM authorization source mismatch' })
      }

      const settled = await config.settle({
        credential,
        payload,
        request,
        source,
      })

      return Receipt.from({
        method: Types.paymentMethod,
        reference: settled.reference,
        status: 'success',
        timestamp: settled.timestamp ?? new Date().toISOString(),
      })
    },
  })
}

export declare namespace charge {
  type Parameters = NativeConfig
  type Native = Method.Server<typeof Methods.charge, Defaults>

  type NativeConfig = BaseConfig & CurrencyConfig & RecipientConfig

  type BaseConfig = {
    /** EIP-3009 token domain metadata. Required for custom currency addresses; inferred for known assets. */
    authorization?: Types.AuthorizationConfig | undefined
    /** EVM chain ID. Required for custom currency addresses; inferred for known assets. */
    chainId?: number | undefined
    /** Token decimal places. Required for custom currency addresses; inferred for known assets. */
    decimals?: number | undefined
    /** Custom settlement override. If omitted, `x402.facilitator` is used. */
    settle?: SettleAuthorization | undefined
    /** x402 compatibility options. */
    x402?: X402.Options | undefined
  }

  type CurrencyConfig = {
    /** Token contract address or known EVM asset metadata. */
    currency: `0x${string}` | Assets.KnownAsset
  }

  type RecipientConfig = {
    /** Recipient wallet address. */
    recipient: `0x${string}`
  }

  type RouteOptions = {
    /** Required display-unit token amount. */
    amount: string
    /** Optional human-readable payment description. */
    description?: string | undefined
    /** Optional external correlation ID. */
    externalId?: string | undefined
  }

  type SettleAuthorization = (parameters: {
    credential: Credential.Credential<Types.AuthorizationPayload>
    payload: Types.AuthorizationPayload
    request: Types.ChargeRequest
    source: ReturnType<typeof Types.toSource>
  }) => Promise<{
    reference: string
    timestamp?: string | undefined
  }>

  type Defaults = {
    chainId: number
    currency: `0x${string}`
    credentialTypes: ['authorization']
    decimals: number
    recipient: `0x${string}`
  }
}

type ResolvedConfig = {
  authorization: Types.AuthorizationConfig
  chainId: number
  currency: `0x${string}`
  decimals: number
  recipient: `0x${string}`
  settle: charge.SettleAuthorization
  x402: X402.ResolvedOptions
}

type HttpPath = {
  bindCredential: NonNullable<ServerTransport.Http['bindCredential']>
  captureRequest?: ServerTransport.Http['captureRequest'] | undefined
  getCredential: ServerTransport.Http['getCredential']
  respondChallenge: (
    options: Parameters<ServerTransport.Http['respondChallenge']>[0],
    response?: Response | undefined,
  ) => Response | Promise<Response>
  respondReceipt: (
    options: Parameters<ServerTransport.Http['respondReceipt']>[0],
    response: Response,
  ) => Response
}

type HttpPaths = {
  mpp: HttpPath
  x402: HttpPath
}

function resolveConfig(config: charge.NativeConfig): ResolvedConfig {
  const { currency, recipient } = config
  let address: `0x${string}`
  let authorization = config.authorization
  let chainId = config.chainId
  let decimals = config.decimals

  if (Assets.isAsset(currency)) {
    address = currency.address
    chainId ??= Number(currency.network.slice('eip155:'.length))
    decimals ??= currency.decimals
    if (currency.transfer.type === Types.eip3009) {
      authorization ??= {
        name: currency.transfer.name,
        version: currency.transfer.version,
      }
    }
  } else {
    address = currency
  }

  if (!authorization) throw new Error('EVM authorization requires `authorization` metadata.')
  if (chainId === undefined) throw new Error('EVM authorization requires `chainId`.')
  if (decimals === undefined) throw new Error('EVM authorization requires `decimals`.')

  const x402 = X402.resolveOptions({
    authorization,
    options: config.x402,
  })
  const settle = config.settle ?? (x402?.facilitator ? X402.settleWithFacilitator(x402) : undefined)
  if (!settle) throw new Error('EVM authorization requires `settle` or `x402.facilitator`.')

  return {
    authorization,
    chainId,
    currency: getAddress(address),
    decimals,
    recipient: getAddress(recipient),
    settle,
    x402,
  }
}

function createPaths(config: ResolvedConfig): HttpPaths {
  return {
    mpp: createMppPath(),
    x402: X402.createPath(config.x402),
  }
}

function createMppPath(): HttpPath {
  const transport = ServerTransport.http()
  return {
    bindCredential: (options) => transport.bindCredential?.(options) ?? options.credential,
    captureRequest: transport.captureRequest,
    getCredential: transport.getCredential,
    respondChallenge: (options) => transport.respondChallenge(options),
    respondReceipt: (options, response) => transport.respondReceipt({ ...options, response }),
  }
}

function httpTransport(paths: HttpPaths): ServerTransport.Http {
  return ServerTransport.from<Request, Response>({
    name: 'evm-http',

    captureRequest: paths.mpp.captureRequest,

    getCredential(input) {
      return paths.mpp.getCredential(input) ?? paths.x402.getCredential(input)
    },

    bindCredential(options) {
      if (X402.isPendingCredential(options.credential)) return paths.x402.bindCredential(options)
      return paths.mpp.bindCredential?.(options) ?? options.credential
    },

    async respondChallenge(options) {
      const response = await paths.mpp.respondChallenge(options)
      return paths.x402.respondChallenge(options, response)
    },

    respondReceipt(options) {
      const response = paths.mpp.respondReceipt(options, options.response)
      return paths.x402.respondReceipt(options, response)
    },
  })
}

function assertAddressEqual(actual: string, expected: string, reason: string) {
  if (getAddress(actual) === getAddress(expected)) return
  throw new VerificationFailedError({ reason })
}
