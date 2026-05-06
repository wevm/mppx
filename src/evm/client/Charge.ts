import { Hex } from 'ox'
import type { Account, Address, TypedDataDomain } from 'viem'
import { encodeFunctionData, erc20Abi } from 'viem'
import {
  prepareTransactionRequest,
  sendTransaction,
  signTransaction,
  signTypedData,
} from 'viem/actions'

import * as Credential from '../../Credential.js'
import * as Method from '../../Method.js'
import * as AccountResolver from '../../viem/Account.js'
import * as Client from '../../viem/Client.js'
import * as z from '../../zod.js'
import * as Address_internal from '../internal/address.js'
import * as Charge_internal from '../internal/charge.js'
import * as Methods from '../Methods.js'

/**
 * Creates an EVM charge method intent for usage on the client.
 *
 * @example
 * ```ts
 * import { evm } from 'mppx/client'
 * import { privateKeyToAccount } from 'viem/accounts'
 *
 * const charge = evm.charge({
 *   account: privateKeyToAccount('0x...'),
 *   rpcUrl: { 1: 'https://...' },
 * })
 * ```
 */
export function charge(parameters: charge.Parameters = {}) {
  const getClient = Client.getResolver({
    getClient: parameters.getClient,
    rpcUrl: parameters.rpcUrl,
  })
  const getAccount = AccountResolver.getResolver({ account: parameters.account })

  return Method.toClient(Methods.charge, {
    context: z.object({
      account: z.optional(z.custom<AccountResolver.getResolver.Parameters['account']>()),
      credentialType: z.optional(z.enum(Methods.credentialTypes)),
    }),

    async createCredential({ challenge, context }) {
      const methodDetails = challenge.request.methodDetails
      const chainId = methodDetails?.chainId
      if (chainId === undefined) throw new Error('EVM charge challenge is missing chainId.')

      const client = await getClient({ chainId })
      const account = getAccount(client, context)
      const credentialType = selectCredentialType({
        challengeTypes: methodDetails?.credentialTypes,
        requested: context?.credentialType ?? parameters.credentialType,
        supportsAuthorization: !!parameters.authorizationDomain,
        supportsPermit2: parameters.permit2 !== false,
      })

      const source = `did:pkh:eip155:${chainId}:${account.address}`
      const payload = await (async () => {
        switch (credentialType) {
          case 'permit2':
            return createPermit2Payload({ account, challenge, client, parameters })
          case 'authorization':
            return createAuthorizationPayload({ account, challenge, client, parameters })
          case 'transaction':
            return createTransactionPayload({ account, challenge, client })
          case 'hash':
            return createHashPayload({ account, challenge, client })
        }
      })()

      return Credential.serialize({ challenge, payload, source })
    },
  })
}

export declare namespace charge {
  type AuthorizationDomain =
    | TypedDataDomain
    | ((parameters: AuthorizationDomainParameters) => Promise<TypedDataDomain> | TypedDataDomain)

  type AuthorizationDomainParameters = {
    chainId: number
    currency: Address
  }

  type Parameters = {
    /** Preferred credential type. Defaults to the first advertised type supported by this client. */
    credentialType?: Methods.CredentialType | undefined
    /**
     * EIP-3009 typed-data domain resolver. Required for `type="authorization"`,
     * because token name/version differ by ERC-20 deployment.
     */
    authorizationDomain?: AuthorizationDomain | undefined
    /** Permit2 signing options. Set to `false` to disable Permit2 client support. */
    permit2?:
      | false
      | {
          deadline?: (() => Promise<bigint> | bigint) | bigint | undefined
          nonce?: (() => Promise<bigint> | bigint) | bigint | undefined
        }
      | undefined
  } & AccountResolver.getResolver.Parameters &
    Client.getResolver.Parameters & {
      /** RPC URLs keyed by chain ID. */
      rpcUrl?: ({ [chainId: number]: string } & object) | undefined
    }
}

function selectCredentialType(parameters: {
  challengeTypes: readonly Methods.CredentialType[] | undefined
  requested: Methods.CredentialType | undefined
  supportsAuthorization: boolean
  supportsPermit2: boolean
}): Methods.CredentialType {
  const available = parameters.challengeTypes ?? ['transaction', 'hash']
  const supported = new Set<Methods.CredentialType>([
    ...(parameters.supportsPermit2 ? (['permit2'] as const) : []),
    ...(parameters.supportsAuthorization ? (['authorization'] as const) : []),
    'transaction',
    'hash',
  ])

  if (parameters.requested) {
    if (!available.includes(parameters.requested))
      throw new Error(`Challenge does not support ${parameters.requested} credentials.`)
    if (!supported.has(parameters.requested))
      throw new Error(`Client is not configured for ${parameters.requested} credentials.`)
    return parameters.requested
  }

  const selected = available.find((type) => supported.has(type))
  if (!selected) throw new Error('No supported EVM credential type advertised by challenge.')
  return selected
}

async function createPermit2Payload(parameters: {
  account: Account
  challenge: Parameters<typeof Methods.charge.schema.request.parse>[0] extends never ? never : any
  client: Parameters<typeof signTypedData>[0]
  parameters: charge.Parameters
}) {
  const { account, challenge, client } = parameters
  const request = challenge.request as z.output<typeof Methods.charge.schema.request>
  const methodDetails = request.methodDetails
  if (!methodDetails?.chainId) throw new Error('EVM charge challenge is missing chainId.')

  const transfers = Charge_internal.getTransfers({
    amount: request.amount,
    methodDetails,
    recipient: request.recipient as Address,
  })
  const permit2Address = Charge_internal.resolvePermit2Address(methodDetails.permit2Address)
  if (!methodDetails.spender)
    throw new Error('Permit2 credential requires challenge.methodDetails.spender.')
  const nonce = await resolveBigInt(
    parameters.parameters.permit2 && typeof parameters.parameters.permit2 === 'object'
      ? parameters.parameters.permit2.nonce
      : undefined,
    randomPermit2Nonce,
  )
  const deadline = await resolveBigInt(
    parameters.parameters.permit2 && typeof parameters.parameters.permit2 === 'object'
      ? parameters.parameters.permit2.deadline
      : undefined,
    challenge.expires
      ? BigInt(Math.floor(new Date(challenge.expires).getTime() / 1000))
      : BigInt(Math.floor(Date.now() / 1000) + 3600),
  )
  const challengeHash = Charge_internal.challengeHash(challenge)
  const permitted = transfers.map((transfer) => ({
    amount: transfer.amount,
    token: request.currency as Address,
  }))
  const transferDetails = transfers.map((transfer) => ({
    requestedAmount: transfer.amount,
    to: transfer.recipient,
  }))

  const batch = transfers.length > 1
  const primaryType = batch ? 'PermitBatchWitnessTransferFrom' : 'PermitWitnessTransferFrom'
  const types = {
    TokenPermissions: Charge_internal.permit2WitnessTypes.TokenPermissions,
    PaymentWitness: Charge_internal.permit2WitnessTypes.PaymentWitness,
    [primaryType]: [
      { name: 'permitted', type: batch ? 'TokenPermissions[]' : 'TokenPermissions' },
      { name: 'spender', type: 'address' },
      { name: 'nonce', type: 'uint256' },
      { name: 'deadline', type: 'uint256' },
      { name: 'witness', type: 'PaymentWitness' },
    ],
  } as const

  const message = {
    permitted: batch
      ? permitted.map((entry) => ({ amount: BigInt(entry.amount), token: entry.token }))
      : { amount: BigInt(permitted[0]!.amount), token: permitted[0]!.token },
    spender: methodDetails.spender,
    nonce,
    deadline,
    witness: { challengeHash },
  }
  const signature = await signTypedData(client, {
    account,
    domain: {
      chainId: methodDetails.chainId,
      name: 'Permit2',
      verifyingContract: permit2Address,
    },
    message,
    primaryType,
    types,
  } as never)

  return {
    permit: {
      deadline: deadline.toString(),
      nonce: nonce.toString(),
      permitted,
    },
    signature,
    transferDetails,
    type: 'permit2' as const,
    witness: { challengeHash },
  }
}

async function createAuthorizationPayload(parameters: {
  account: Account
  challenge: any
  client: Parameters<typeof signTypedData>[0]
  parameters: charge.Parameters
}) {
  const { account, challenge, client } = parameters
  const request = challenge.request as z.output<typeof Methods.charge.schema.request>
  const methodDetails = request.methodDetails
  if (!methodDetails?.chainId) throw new Error('EVM charge challenge is missing chainId.')
  if (methodDetails.splits)
    throw new Error('EIP-3009 authorization credentials do not support splits.')
  if (!parameters.parameters.authorizationDomain)
    throw new Error('authorizationDomain is required for EIP-3009 credentials.')

  const challengeHash = Charge_internal.challengeHash(challenge)
  const validBefore = challenge.expires
    ? BigInt(Math.floor(new Date(challenge.expires).getTime() / 1000))
    : BigInt(Math.floor(Date.now() / 1000) + 3600)
  const domain = await resolveAuthorizationDomain(parameters.parameters.authorizationDomain, {
    chainId: methodDetails.chainId,
    currency: request.currency as Address,
  })
  const message = {
    from: account.address,
    nonce: challengeHash,
    to: request.recipient as Address,
    validAfter: 0n,
    validBefore,
    value: BigInt(request.amount),
  }
  const signature = await signTypedData(client, {
    account,
    domain,
    message,
    primaryType: 'TransferWithAuthorization',
    types: Charge_internal.eip3009Types,
  })

  return {
    from: account.address,
    nonce: challengeHash,
    signature,
    to: request.recipient as Address,
    type: 'authorization' as const,
    validAfter: '0',
    validBefore: validBefore.toString(),
    value: request.amount,
  }
}

async function createTransactionPayload(parameters: {
  account: Account
  challenge: any
  client: Parameters<typeof prepareTransactionRequest>[0]
}) {
  const { account, challenge, client } = parameters
  const request = challenge.request as z.output<typeof Methods.charge.schema.request>
  if (request.methodDetails?.splits)
    throw new Error('Transaction credentials do not support splits.')
  const data = encodeFunctionData({
    abi: erc20Abi,
    functionName: 'transfer',
    args: [request.recipient as Address, BigInt(request.amount)],
  })
  const prepared = await prepareTransactionRequest(client, {
    account,
    chain: (client as { chain?: unknown }).chain ?? null,
    data,
    to: request.currency as Address,
  } as never)
  const signature = await signTransaction(client, prepared as never)
  return { signature, type: 'transaction' as const }
}

async function createHashPayload(parameters: {
  account: Account
  challenge: any
  client: Parameters<typeof sendTransaction>[0]
}) {
  const { account, challenge, client } = parameters
  const request = challenge.request as z.output<typeof Methods.charge.schema.request>
  if (request.methodDetails?.splits) throw new Error('Hash credentials do not support splits.')
  const hash = await sendTransaction(client, {
    account,
    chain: (client as { chain?: unknown }).chain ?? null,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: 'transfer',
      args: [request.recipient as Address, BigInt(request.amount)],
    }),
    to: request.currency as Address,
  } as never)
  return { hash, type: 'hash' as const }
}

async function resolveBigInt(
  value: (() => Promise<bigint> | bigint) | bigint | undefined,
  fallback: (() => bigint) | bigint,
) {
  if (typeof value === 'function') return value()
  return value ?? (typeof fallback === 'function' ? fallback() : fallback)
}

function randomPermit2Nonce() {
  let nonce = 0n
  while (nonce === 0n) nonce = BigInt(Hex.random(32))
  return nonce
}

async function resolveAuthorizationDomain(
  domain: charge.AuthorizationDomain,
  parameters: charge.AuthorizationDomainParameters,
) {
  const resolved = typeof domain === 'function' ? await domain(parameters) : domain
  return {
    ...resolved,
    chainId: resolved.chainId ?? parameters.chainId,
    verifyingContract:
      resolved.verifyingContract ?? Address_internal.normalize(parameters.currency),
  }
}
