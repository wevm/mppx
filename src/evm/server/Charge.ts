import {
  decodeFunctionData,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  hexToNumber,
  isAddressEqual,
  keccak256,
  parseEventLogs,
  parseTransaction,
  slice,
  type Address,
  type Hex,
  type TransactionReceipt,
  type TypedDataDomain,
} from 'viem'
import {
  call,
  getTransaction,
  getTransactionReceipt,
  readContract,
  sendRawTransaction,
  verifyTypedData,
  waitForTransactionReceipt,
  writeContract,
} from 'viem/actions'

import { VerificationFailedError } from '../../Errors.js'
import * as Expires from '../../Expires.js'
import type { LooseOmit, NoExtraKeys } from '../../internal/types.js'
import * as Method from '../../Method.js'
import * as Receipt from '../../Receipt.js'
import * as Store from '../../Store.js'
import * as Account from '../../viem/Account.js'
import * as Client from '../../viem/Client.js'
import type * as z from '../../zod.js'
import { eip3009Abi, permit2Abi } from '../internal/abis.js'
import * as Address_internal from '../internal/address.js'
import * as Charge_internal from '../internal/charge.js'
import * as Methods from '../Methods.js'

/**
 * Creates an EVM charge method intent for usage on the server.
 *
 * @example
 * ```ts
 * import { evm } from 'mppx/server'
 *
 * const charge = evm.charge({
 *   amount: '1',
 *   chainId: 1,
 *   currency: '0x...',
 *   decimals: 6,
 *   recipient: '0x...',
 *   rpcUrl: { 1: 'https://...' },
 * })
 * ```
 */
export function charge<const parameters extends charge.Parameters>(
  parameters: NoExtraKeys<parameters, charge.Parameters>,
) {
  const {
    amount,
    chainId,
    credentialTypes,
    currency,
    decimals,
    description,
    externalId,
    permit2Address,
    recipient,
    spender,
    splits,
  } = parameters
  const store = (parameters.store ?? Store.memory()) as Store.AtomicStore<charge.StoreItemMap>
  const getClient = Client.getResolver({
    getClient: parameters.getClient,
    rpcUrl: parameters.rpcUrl,
  })
  const getAccount = Account.getResolver({ account: parameters.account })

  const resolvedCredentialTypes =
    credentialTypes ??
    Charge_internal.defaultCredentialTypes({
      authorization: !!parameters.authorizationDomain,
      serverPaysGas: !!parameters.account,
    })

  type Defaults = charge.DeriveDefaults<parameters>
  return Method.toServer<typeof Methods.charge, Defaults>(Methods.charge, {
    defaults: {
      amount,
      chainId,
      credentialTypes: resolvedCredentialTypes,
      currency,
      decimals,
      description,
      externalId,
      permit2Address,
      recipient,
      spender: spender ?? resolveAccountAddress(parameters.account),
      splits,
    } as unknown as Defaults,

    async request({ request }) {
      if (request.splits && request.credentialTypes?.some((type) => type !== 'permit2')) {
        return { ...request, credentialTypes: ['permit2'] }
      }
      return request
    },

    async verify({ credential, request }) {
      const { challenge } = credential
      const resolvedRequest = (() => {
        const parsed = Methods.charge.schema.request.safeParse(request)
        if (parsed.success) return parsed.data
        return request as unknown as z.output<typeof Methods.charge.schema.request>
      })()
      const methodDetails = resolvedRequest.methodDetails
      const resolvedChainId = methodDetails?.chainId ?? request.chainId
      if (resolvedChainId === undefined)
        throw new VerificationFailedError({ reason: 'EVM charge challenge is missing chainId.' })

      Expires.assert(challenge.expires, challenge.id)

      const payload = credential.payload
      if (methodDetails?.splits && payload.type !== 'permit2')
        throw new VerificationFailedError({ reason: 'Only Permit2 credentials support splits.' })

      const client = await getClient({ chainId: resolvedChainId })

      switch (payload.type) {
        case 'permit2':
          return verifyPermit2({
            challenge,
            client,
            credential: { payload, source: credential.source },
            getAccount,
            parameters,
            request: resolvedRequest,
            store,
          })
        case 'authorization':
          return verifyAuthorization({
            challenge,
            client,
            credential: { payload, source: credential.source },
            getAccount,
            parameters,
            request: resolvedRequest,
            store,
          })
        case 'transaction':
          return verifyTransaction({
            client,
            challenge,
            payload,
            request: resolvedRequest,
            store,
          })
        case 'hash':
          return verifyHash({ challenge, client, payload, request: resolvedRequest, store })
        default:
          throw new VerificationFailedError({ reason: 'Unsupported EVM credential type.' })
      }
    },
  })
}

export declare namespace charge {
  type StoreItemMap = { [key: `mppx:evm:charge:${string}`]: number }

  type Defaults = LooseOmit<Method.RequestDefaults<typeof Methods.charge>, never>

  type AuthorizationDomain =
    | TypedDataDomain
    | ((parameters: {
        chainId: number
        currency: Address
      }) => Promise<TypedDataDomain> | TypedDataDomain)

  type Parameters = {
    /** Account used by the server to submit Permit2 and EIP-3009 transactions. */
    account?: Account.getResolver.Parameters['account'] | undefined
    /** EIP-3009 typed-data domain resolver. Enables `type="authorization"`. */
    authorizationDomain?: AuthorizationDomain | undefined
    /** Store for atomic replay protection. */
    store?: Store.AtomicStore | undefined
  } & Client.getResolver.Parameters &
    Defaults & {
      /** RPC URLs keyed by chain ID. */
      rpcUrl?: ({ [chainId: number]: string } & object) | undefined
    }

  type DeriveDefaults<parameters extends Parameters> = Pick<
    parameters,
    Extract<keyof parameters, keyof Defaults>
  >
}

async function verifyPermit2(parameters: {
  challenge: { id: string; realm: string; expires?: string | undefined }
  client: any
  credential: {
    payload: Extract<z.output<typeof Methods.charge.schema.credential.payload>, { type: 'permit2' }>
    source?: string | undefined
  }
  getAccount: ReturnType<typeof Account.getResolver>
  parameters: charge.Parameters
  request: z.output<typeof Methods.charge.schema.request>
  store: Store.AtomicStore<charge.StoreItemMap>
}): Promise<Receipt.Receipt> {
  const { challenge, client, credential, request } = parameters
  const methodDetails = request.methodDetails!
  const source = Address_internal.parseSource(credential.source)
  if (!source || source.chainId !== methodDetails.chainId)
    throw new VerificationFailedError({ reason: 'Permit2 credential source is invalid.' })

  const serverAccount = parameters.getAccount(client, {})
  if (
    methodDetails.spender &&
    !Address_internal.equal(methodDetails.spender, serverAccount.address)
  )
    throw new VerificationFailedError({ reason: 'Permit2 spender does not match server account.' })
  const expectedHash = Charge_internal.challengeHash(challenge)
  const payload = credential.payload
  if (payload.witness.challengeHash.toLowerCase() !== expectedHash.toLowerCase())
    throw new VerificationFailedError({ reason: 'Permit2 witness does not match challenge.' })

  const transfers = Charge_internal.getTransfers({
    amount: request.amount,
    methodDetails,
    recipient: request.recipient as Address,
  })
  assertPermit2Transfers(payload, { currency: request.currency as Address, transfers })

  const replayKey = `permit2:${methodDetails.chainId}:${source.address.toLowerCase()}:${payload.permit.nonce}`
  if (!(await markUsed(parameters.store, replayKey)))
    throw new VerificationFailedError({ reason: 'Permit2 credential has already been used.' })

  try {
    const valid = await verifyPermit2Signature(client, {
      address: source.address,
      payload,
      permit2Address: Charge_internal.resolvePermit2Address(methodDetails.permit2Address),
      chainId: methodDetails.chainId!,
      challengeHash: expectedHash,
      spender: serverAccount.address,
    })
    if (!valid) throw new VerificationFailedError({ reason: 'Permit2 signature is invalid.' })
    if (BigInt(payload.permit.deadline) < BigInt(Math.floor(Date.now() / 1000)))
      throw new VerificationFailedError({ reason: 'Permit2 deadline has passed.' })

    await assertBalance(client, {
      amount: request.amount,
      currency: request.currency as Address,
      owner: source.address,
    })
    await assertPermit2TokenApproval(client, {
      amount: request.amount,
      currency: request.currency as Address,
      owner: source.address,
      permit2Address: Charge_internal.resolvePermit2Address(methodDetails.permit2Address),
    })

    const receipt = await submitPermit2(client, {
      account: serverAccount,
      owner: source.address,
      payload,
      permit2Address: Charge_internal.resolvePermit2Address(methodDetails.permit2Address),
    })
    assertTransferLogs(receipt, {
      currency: request.currency as Address,
      sender: source.address,
      transfers,
    })
    return toReceipt(receipt, { challenge, chainId: methodDetails.chainId!, request })
  } catch (error) {
    await releaseUsed(parameters.store, replayKey)
    throw error
  }
}

async function verifyAuthorization(parameters: {
  challenge: { id: string; realm: string; expires?: string | undefined }
  client: any
  credential: {
    payload: Extract<
      z.output<typeof Methods.charge.schema.credential.payload>,
      { type: 'authorization' }
    >
    source?: string | undefined
  }
  getAccount: ReturnType<typeof Account.getResolver>
  parameters: charge.Parameters
  request: z.output<typeof Methods.charge.schema.request>
  store: Store.AtomicStore<charge.StoreItemMap>
}): Promise<Receipt.Receipt> {
  const { challenge, client, credential, request } = parameters
  const methodDetails = request.methodDetails!
  if (!parameters.parameters.authorizationDomain)
    throw new VerificationFailedError({ reason: 'EIP-3009 authorization is not enabled.' })
  if (methodDetails.splits)
    throw new VerificationFailedError({ reason: 'EIP-3009 authorization does not support splits.' })

  const payload = credential.payload
  const expectedHash = Charge_internal.challengeHash(challenge)
  if (!Address_internal.equal(payload.to, request.recipient))
    throw new VerificationFailedError({
      reason: 'Authorization recipient does not match challenge.',
    })
  if (payload.value !== request.amount)
    throw new VerificationFailedError({ reason: 'Authorization amount does not match challenge.' })
  if (payload.nonce.toLowerCase() !== expectedHash.toLowerCase())
    throw new VerificationFailedError({ reason: 'Authorization nonce does not match challenge.' })
  if (BigInt(payload.validBefore) < BigInt(Math.floor(Date.now() / 1000)))
    throw new VerificationFailedError({ reason: 'Authorization has expired.' })

  const source = Address_internal.parseSource(credential.source)
  if (
    source &&
    (!Address_internal.equal(source.address, payload.from) ||
      source.chainId !== methodDetails.chainId)
  )
    throw new VerificationFailedError({ reason: 'Authorization source is invalid.' })

  const replayKey = `authorization:${methodDetails.chainId}:${payload.from.toLowerCase()}:${payload.nonce.toLowerCase()}`
  if (!(await markUsed(parameters.store, replayKey)))
    throw new VerificationFailedError({ reason: 'Authorization credential has already been used.' })

  try {
    const domain = await resolveAuthorizationDomain(parameters.parameters.authorizationDomain, {
      chainId: methodDetails.chainId!,
      currency: request.currency as Address,
    })
    const valid = await verifyTypedData(client, {
      address: payload.from as Address,
      domain,
      message: {
        from: payload.from,
        nonce: payload.nonce as Hex,
        to: payload.to,
        validAfter: BigInt(payload.validAfter),
        validBefore: BigInt(payload.validBefore),
        value: BigInt(payload.value),
      },
      primaryType: 'TransferWithAuthorization',
      signature: payload.signature as Hex,
      types: Charge_internal.eip3009Types,
    })
    if (!valid) throw new VerificationFailedError({ reason: 'Authorization signature is invalid.' })

    await assertBalance(client, {
      amount: request.amount,
      currency: request.currency as Address,
      owner: payload.from as Address,
    })

    const account = parameters.getAccount(client, {})
    const [v, r, s] = splitSignature(payload.signature as Hex)
    const request_ = {
      abi: eip3009Abi,
      account,
      address: request.currency as Address,
      args: [
        payload.from as Address,
        payload.to as Address,
        BigInt(payload.value),
        BigInt(payload.validAfter),
        BigInt(payload.validBefore),
        payload.nonce as Hex,
        v,
        r,
        s,
      ],
      functionName: 'transferWithAuthorization',
    } as const
    await call(client, {
      account,
      data: encodeCallData(request_),
      to: request.currency as Address,
    } as never)
    const hash = await writeContract(client, request_ as never)
    const receipt = await waitForTransactionReceipt(client, { hash })
    assertTransferLogs(receipt, {
      currency: request.currency as Address,
      sender: payload.from as Address,
      transfers: [{ amount: request.amount, recipient: request.recipient as Address }],
    })
    return toReceipt(receipt, { challenge, chainId: methodDetails.chainId!, request })
  } catch (error) {
    await releaseUsed(parameters.store, replayKey)
    throw error
  }
}

async function verifyTransaction(parameters: {
  challenge: { id: string }
  client: any
  payload: Extract<
    z.output<typeof Methods.charge.schema.credential.payload>,
    { type: 'transaction' }
  >
  request: z.output<typeof Methods.charge.schema.request>
  store: Store.AtomicStore<charge.StoreItemMap>
}): Promise<Receipt.Receipt> {
  const { client, payload, request } = parameters
  const methodDetails = request.methodDetails!
  if (methodDetails.splits)
    throw new VerificationFailedError({ reason: 'Transaction credentials do not support splits.' })
  const serialized = payload.signature as Hex
  const hash = keccak256(serialized)
  if (!(await markUsed(parameters.store, `tx:${hash.toLowerCase()}`)))
    throw new VerificationFailedError({ reason: 'Transaction has already been used.' })

  try {
    const transaction = parseTransaction(serialized) as any
    const data = transaction.data ?? transaction.input
    if (transaction.chainId !== undefined && transaction.chainId !== methodDetails.chainId)
      throw new VerificationFailedError({ reason: 'Transaction chainId does not match challenge.' })
    assertTransferCall({ data, to: transaction.to }, request)

    const reference = await sendRawTransaction(client, { serializedTransaction: serialized })
    const receipt = await waitForTransactionReceipt(client, { hash: reference })
    assertTransferLogs(receipt, {
      currency: request.currency as Address,
      sender: receipt.from,
      transfers: [{ amount: request.amount, recipient: request.recipient as Address }],
    })
    if (reference.toLowerCase() !== hash.toLowerCase())
      await markUsed(parameters.store, `tx:${reference.toLowerCase()}`)
    return toReceipt(receipt, {
      challenge: parameters.challenge,
      chainId: methodDetails.chainId!,
      request,
    })
  } catch (error) {
    await releaseUsed(parameters.store, `tx:${hash.toLowerCase()}`)
    throw error
  }
}

async function verifyHash(parameters: {
  challenge: { id: string }
  client: any
  payload: Extract<z.output<typeof Methods.charge.schema.credential.payload>, { type: 'hash' }>
  request: z.output<typeof Methods.charge.schema.request>
  store: Store.AtomicStore<charge.StoreItemMap>
}): Promise<Receipt.Receipt> {
  const { client, payload, request } = parameters
  const methodDetails = request.methodDetails!
  if (methodDetails.splits)
    throw new VerificationFailedError({ reason: 'Hash credentials do not support splits.' })
  const hash = payload.hash as Hex
  const receipt = await getTransactionReceipt(client, { hash })
  const transaction = await getTransaction(client, { hash }).catch(() => undefined)
  if (transaction?.to) assertTransferCall({ data: transaction.input, to: transaction.to }, request)
  assertTransferLogs(receipt, {
    currency: request.currency as Address,
    sender: receipt.from,
    transfers: [{ amount: request.amount, recipient: request.recipient as Address }],
  })
  if (!(await markUsed(parameters.store, `hash:${hash.toLowerCase()}`)))
    throw new VerificationFailedError({ reason: 'Transaction hash has already been used.' })
  return toReceipt(receipt, {
    challenge: parameters.challenge,
    chainId: methodDetails.chainId!,
    request,
  })
}

function assertPermit2Transfers(
  payload: Extract<z.output<typeof Methods.charge.schema.credential.payload>, { type: 'permit2' }>,
  parameters: { currency: Address; transfers: readonly Charge_internal.Transfer[] },
) {
  if (payload.permit.permitted.length !== payload.transferDetails.length)
    throw new VerificationFailedError({
      reason: 'Permit2 permitted and transferDetails lengths differ.',
    })
  if (payload.transferDetails.length !== parameters.transfers.length)
    throw new VerificationFailedError({
      reason: 'Permit2 transfer count does not match challenge.',
    })

  parameters.transfers.forEach((transfer, index) => {
    const permitted = payload.permit.permitted[index]!
    const details = payload.transferDetails[index]!
    if (!Address_internal.equal(permitted.token, parameters.currency))
      throw new VerificationFailedError({ reason: 'Permit2 token does not match challenge.' })
    if (BigInt(permitted.amount) < BigInt(transfer.amount))
      throw new VerificationFailedError({ reason: 'Permit2 permitted amount is too low.' })
    if (!Address_internal.equal(details.to, transfer.recipient))
      throw new VerificationFailedError({ reason: 'Permit2 recipient does not match challenge.' })
    if (details.requestedAmount !== transfer.amount)
      throw new VerificationFailedError({ reason: 'Permit2 amount does not match challenge.' })
  })
}

async function verifyPermit2Signature(
  client: any,
  parameters: {
    address: Address
    chainId: number
    challengeHash: Hex
    payload: Extract<z.output<typeof Methods.charge.schema.credential.payload>, { type: 'permit2' }>
    permit2Address: Address
    spender: Address
  },
) {
  const { payload } = parameters
  const batch = payload.permit.permitted.length > 1
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
  return verifyTypedData(client, {
    address: parameters.address,
    domain: {
      chainId: parameters.chainId,
      name: 'Permit2',
      verifyingContract: parameters.permit2Address,
    },
    message: {
      permitted: batch
        ? payload.permit.permitted.map((entry) => ({
            amount: BigInt(entry.amount),
            token: entry.token,
          }))
        : {
            amount: BigInt(payload.permit.permitted[0]!.amount),
            token: payload.permit.permitted[0]!.token,
          },
      spender: parameters.spender,
      nonce: BigInt(payload.permit.nonce),
      deadline: BigInt(payload.permit.deadline),
      witness: { challengeHash: parameters.challengeHash },
    },
    primaryType,
    signature: payload.signature as Hex,
    types,
  } as never)
}

async function assertBalance(
  client: any,
  parameters: { amount: string; currency: Address; owner: Address },
) {
  const balance = await readContract(client, {
    abi: erc20Abi,
    address: parameters.currency,
    args: [parameters.owner],
    functionName: 'balanceOf',
  })
  if (balance < BigInt(parameters.amount))
    throw new VerificationFailedError({ reason: 'Token balance is insufficient.' })
}

async function assertPermit2TokenApproval(
  client: any,
  parameters: {
    amount: string
    currency: Address
    owner: Address
    permit2Address: Address
  },
) {
  const allowance = await readContract(client, {
    abi: erc20Abi,
    address: parameters.currency,
    args: [parameters.owner, parameters.permit2Address],
    functionName: 'allowance',
  })
  if (allowance < BigInt(parameters.amount))
    throw new VerificationFailedError({ reason: 'Permit2 token approval is insufficient.' })
}

async function submitPermit2(
  client: any,
  parameters: {
    account: Account.Account
    owner: Address
    payload: Extract<z.output<typeof Methods.charge.schema.credential.payload>, { type: 'permit2' }>
    permit2Address: Address
  },
): Promise<TransactionReceipt> {
  const { payload } = parameters
  const batch = payload.permit.permitted.length > 1
  const args = batch
    ? [
        {
          deadline: BigInt(payload.permit.deadline),
          nonce: BigInt(payload.permit.nonce),
          permitted: payload.permit.permitted.map((entry) => ({
            amount: BigInt(entry.amount),
            token: entry.token,
          })),
        },
        payload.transferDetails.map((entry) => ({
          requestedAmount: BigInt(entry.requestedAmount),
          to: entry.to,
        })),
        parameters.owner,
        payload.witness.challengeHash as Hex,
        Charge_internal.witnessTypeString,
        payload.signature as Hex,
      ]
    : [
        {
          deadline: BigInt(payload.permit.deadline),
          nonce: BigInt(payload.permit.nonce),
          permitted: {
            amount: BigInt(payload.permit.permitted[0]!.amount),
            token: payload.permit.permitted[0]!.token,
          },
        },
        {
          requestedAmount: BigInt(payload.transferDetails[0]!.requestedAmount),
          to: payload.transferDetails[0]!.to,
        },
        parameters.owner,
        payload.witness.challengeHash as Hex,
        Charge_internal.witnessTypeString,
        payload.signature as Hex,
      ]
  const functionName = batch ? 'permitBatchWitnessTransferFrom' : 'permitWitnessTransferFrom'
  const request = {
    abi: permit2Abi,
    account: parameters.account,
    address: parameters.permit2Address,
    args,
    functionName,
  } as const
  await call(client, {
    account: parameters.account,
    data: encodeCallData(request),
    to: parameters.permit2Address,
  } as never)
  const hash = await writeContract(client, request as never)
  return waitForTransactionReceipt(client, { hash })
}

function assertTransferCall(
  call: { data?: Hex | undefined; to?: Address | undefined },
  request: z.output<typeof Methods.charge.schema.request>,
) {
  if (!call.to || !isAddressEqual(getAddress(call.to), getAddress(request.currency)))
    throw new VerificationFailedError({ reason: 'Transaction token does not match challenge.' })
  if (!call.data) throw new VerificationFailedError({ reason: 'Transaction calldata is missing.' })

  const decoded = decodeFunctionData({ abi: erc20Abi, data: call.data })
  if (decoded.functionName !== 'transfer')
    throw new VerificationFailedError({ reason: 'Transaction is not an ERC-20 transfer.' })
  const [recipient, amount] = decoded.args as [Address, bigint]
  if (!Address_internal.equal(recipient, request.recipient))
    throw new VerificationFailedError({ reason: 'Transaction recipient does not match challenge.' })
  if (amount.toString() !== request.amount)
    throw new VerificationFailedError({ reason: 'Transaction amount does not match challenge.' })
}

function assertTransferLogs(
  receipt: TransactionReceipt,
  parameters: {
    currency: Address
    sender: Address
    transfers: readonly Charge_internal.Transfer[]
  },
) {
  if (receipt.status !== 'success')
    throw new Error(`Transaction reverted: ${receipt.transactionHash}`)
  const logs = parseEventLogs({
    abi: erc20Abi,
    eventName: 'Transfer',
    logs: receipt.logs,
  })
  const used = new Set<number>()
  for (const transfer of parameters.transfers) {
    const index = logs.findIndex((log, logIndex) => {
      if (used.has(logIndex)) return false
      if (!Address_internal.equal(log.address, parameters.currency)) return false
      if (!Address_internal.equal(log.args.from, parameters.sender)) return false
      if (!Address_internal.equal(log.args.to, transfer.recipient)) return false
      return log.args.value.toString() === transfer.amount
    })
    if (index === -1)
      throw new VerificationFailedError({
        reason: 'Payment verification failed: no matching transfer found.',
      })
    used.add(index)
  }
}

function splitSignature(signature: Hex): [number, Hex, Hex] {
  const r = slice(signature, 0, 32)
  const s = slice(signature, 32, 64)
  const v = hexToNumber(slice(signature, 64, 65))
  return [v, r, s]
}

function encodeCallData(request: {
  abi: readonly unknown[]
  args: readonly unknown[]
  functionName: string
}) {
  return encodeFunctionData(request as never)
}

function toReceipt(
  receipt: TransactionReceipt,
  parameters: {
    challenge?: { id: string } | undefined
    chainId: number
    request: z.output<typeof Methods.charge.schema.request>
  },
): Receipt.Receipt {
  if (receipt.status !== 'success')
    throw new Error(`Transaction reverted: ${receipt.transactionHash}`)
  return {
    method: 'evm',
    reference: receipt.transactionHash,
    status: 'success',
    timestamp: new Date().toISOString(),
    ...(parameters.challenge && { challengeId: parameters.challenge.id }),
    chainId: parameters.chainId,
    ...(parameters.request.externalId && { externalId: parameters.request.externalId }),
  } as Receipt.Receipt
}

async function resolveAuthorizationDomain(
  domain: charge.AuthorizationDomain,
  parameters: { chainId: number; currency: Address },
) {
  const resolved = typeof domain === 'function' ? await domain(parameters) : domain
  return {
    ...resolved,
    chainId: resolved.chainId ?? parameters.chainId,
    verifyingContract:
      resolved.verifyingContract ?? Address_internal.normalize(parameters.currency),
  }
}

function getStoreKey(key: string): `mppx:evm:charge:${string}` {
  return `mppx:evm:charge:${key}`
}

async function markUsed(store: Store.AtomicStore<charge.StoreItemMap>, key: string) {
  return store.update(getStoreKey(key), (current) => {
    if (current !== null) return { op: 'noop', result: false }
    return { op: 'set', value: Date.now(), result: true }
  })
}

async function releaseUsed(store: Store.AtomicStore<charge.StoreItemMap>, key: string) {
  await store.delete(getStoreKey(key))
}

function resolveAccountAddress(account: charge.Parameters['account']): Address | undefined {
  if (!account) return undefined
  if (typeof account === 'string') return account as Address
  return account.address
}
