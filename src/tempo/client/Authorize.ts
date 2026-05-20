import { Hex } from 'ox'
import { encodeFunctionData, type Account, type Address, type Client as ViemClient } from 'viem'
import { prepareTransactionRequest, signTransaction } from 'viem/actions'
import { tempo as tempo_chain } from 'viem/chains'

import * as Credential from '../../Credential.js'
import type { MaybePromise } from '../../internal/types.js'
import * as Method from '../../Method.js'
import * as AccountResolver from '../../viem/Account.js'
import * as Client from '../../viem/Client.js'
import * as z from '../../zod.js'
import * as defaults from '../internal/defaults.js'
import * as Methods from '../Methods.js'
import * as Channel from '../precompile/Channel.js'
import { tip20ChannelEscrow } from '../precompile/Constants.js'
import { escrowAbi } from '../precompile/escrow.abi.js'

type AuthorizeRequest = ReturnType<typeof Methods.authorize.schema.request.parse>
const expiringNonceValiditySeconds = 20

/** Context accepted by the Tempo authorize client method. */
export const authorizeContextSchema = z.object({
  account: z.optional(z.custom<AccountResolver.getResolver.Parameters['account']>()),
})

/** Creates a Tempo authorize client method. */
export function authorize(parameters: authorize.Parameters = {}) {
  const getClient = Client.getResolver({
    chain: tempo_chain,
    getClient: parameters.getClient,
    rpcUrl: defaults.rpcUrl,
  })
  const getAccount = AccountResolver.getResolver({ account: parameters.account })

  return Method.toClient(Methods.authorize, {
    context: authorizeContextSchema,

    async createCredential({ challenge, context }) {
      await parameters.validateRequest?.(challenge.request)

      const chainId = challenge.request.methodDetails.chainId ?? defaults.chainId.mainnet
      const client = await getClient({ chainId })
      const account = getAccount(client, context)
      const payload = await createAuthorizePayload(client, account, challenge.request, {
        chainId,
        expires: challenge.expires,
      })

      return Credential.serialize({
        challenge,
        payload,
        source: `did:pkh:eip155:${chainId}:${account.address}`,
      })
    },
  })
}

async function createAuthorizePayload(
  client: ViemClient,
  account: Account,
  request: AuthorizeRequest,
  options: { chainId: number; expires?: string | undefined },
) {
  const methodDetails = request.methodDetails
  const escrow = (methodDetails.escrowContract ?? tip20ChannelEscrow) as Address
  const salt = Hex.random(32)
  const prepared = await prepareTransactionRequest(client, {
    account,
    calls: [{ to: escrow, data: encodeOpenCall(request, salt) }],
    ...(methodDetails.feePayer ? { feePayer: true } : {}),
    feeToken: request.currency as Address,
    nonceKey: 'expiring',
    validBefore: toValidBefore(options.expires),
  } as never)
  const expiringNonceHash = Channel.computeExpiringNonceHash(
    prepared as Channel.ExpiringNonceTransaction,
    { sender: account.address },
  )
  const channelId = Channel.computeId({
    authorizedSigner: methodDetails.authorizedSigner as Address,
    chainId: options.chainId,
    escrow,
    expiringNonceHash,
    operator: methodDetails.operator as Address,
    payee: request.recipient as Address,
    payer: account.address,
    salt,
    token: request.currency as Address,
  })
  return {
    channelId,
    transaction: (await signTransaction(client, prepared as never)) as Hex.Hex,
  }
}

function encodeOpenCall(request: AuthorizeRequest, salt: Hex.Hex) {
  const methodDetails = request.methodDetails
  return encodeFunctionData({
    abi: escrowAbi,
    functionName: 'open',
    args: [
      request.recipient as Address,
      methodDetails.operator as Address,
      request.currency as Address,
      BigInt(request.amount),
      salt,
      methodDetails.authorizedSigner as Address,
    ],
  })
}

function toValidBefore(expires: string | undefined) {
  if (!expires) throw new Error('tempo.authorize() requires a challenge expiry.')
  const challengeExpires = Math.floor(new Date(expires).getTime() / 1_000)
  const nonceExpires = Math.floor(Date.now() / 1_000) + expiringNonceValiditySeconds
  return Math.min(challengeExpires, nonceExpires)
}

export declare namespace authorize {
  type Parameters = AccountResolver.getResolver.Parameters &
    Client.getResolver.Parameters & {
      validateRequest?: ((request: AuthorizeRequest) => MaybePromise<void>) | undefined
    }
}
