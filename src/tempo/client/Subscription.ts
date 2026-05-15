import { Hex } from 'ox'
import { KeyAuthorization } from 'ox/tempo'
import { isAddressEqual, type Address } from 'viem'
import { tempo as tempo_chain } from 'viem/chains'

import * as Credential from '../../Credential.js'
import type { MaybePromise } from '../../internal/types.js'
import * as Method from '../../Method.js'
import * as Account from '../../viem/Account.js'
import * as Client from '../../viem/Client.js'
import * as z from '../../zod.js'
import * as defaults from '../internal/defaults.js'
import * as Methods from '../Methods.js'
import {
  getSubscriptionScopes,
  signSubscriptionKeyAuthorization,
  toSubscriptionExpiryDate,
  toSubscriptionExpirySeconds,
  toSubscriptionPeriodSeconds,
  verifySubscriptionKeyAuthorization,
} from '../subscription/KeyAuthorization.js'
import type { SubscriptionAccessKey } from '../subscription/Types.js'

type SubscriptionRequest = ReturnType<typeof Methods.subscription.schema.request.parse>

/** Context accepted by the Tempo subscription client method. */
export const subscriptionContextSchema = z.object({
  accessKey: z.optional(z.custom<SubscriptionAccessKey>()),
  account: z.optional(z.custom<Account.getResolver.Parameters['account']>()),
})

/** Runtime context for creating a Tempo subscription credential. */
export type SubscriptionContext = z.infer<typeof subscriptionContextSchema>

/** Creates a Tempo subscription client method. */
export function subscription(parameters: subscription.Parameters = {}) {
  const getClient = Client.getResolver({
    chain: tempo_chain,
    getClient: parameters.getClient,
    rpcUrl: defaults.rpcUrl,
  })
  const getAccount = Account.getResolver({ account: parameters.account })

  return Method.toClient(Methods.subscription, {
    context: subscriptionContextSchema,

    async createCredential({ challenge, context }) {
      const chainId = challenge.request.methodDetails?.chainId ?? defaults.chainId.testnet
      const client = await getClient({ chainId })
      const account = getAccount(client, context)
      const accessKey =
        context?.accessKey ?? parameters.accessKey ?? challenge.request.methodDetails?.accessKey
      if (!accessKey) {
        throw new Error(
          'No `accessKey` provided. The subscription challenge must include `accessKey`, or the client must pass one to parameters/context.',
        )
      }

      assertSubscriptionRequestRepresentable(challenge.request)
      await parameters.validateRequest?.(challenge.request)

      const keyAuthorization = await authorizeAccessKey(client, {
        accessKey,
        account,
        chainId,
        request: challenge.request,
      } as never)

      const verified = verifySubscriptionKeyAuthorization({
        accessKey,
        chainId,
        payload: {
          signature: KeyAuthorization.serialize(keyAuthorization as never),
          type: 'keyAuthorization',
        },
        request: challenge.request,
      })
      if (!isAddressEqual(verified.source.address, account.address)) {
        throw new Error('keyAuthorization signer does not match the selected account')
      }

      return Credential.serialize({
        challenge,
        payload: {
          signature: KeyAuthorization.serialize(keyAuthorization as never),
          type: 'keyAuthorization',
        },
        source: `did:pkh:eip155:${chainId}:${account.address.toLowerCase()}`,
      })
    },
  })
}

async function authorizeAccessKey(
  client: Awaited<ReturnType<ReturnType<typeof Client.getResolver>>>,
  parameters: {
    accessKey: SubscriptionAccessKey
    account: Account.Account
    chainId: number
    request: Pick<
      SubscriptionRequest,
      'amount' | 'currency' | 'periodCount' | 'periodUnit' | 'recipient' | 'subscriptionExpires'
    >
  },
) {
  const { accessKey, account, chainId, request } = parameters

  const local = await signSubscriptionKeyAuthorization({
    accessKey,
    account,
    chainId,
    request,
  })
  if (local) return local

  const result = (await client.request({
    method: 'wallet_authorizeAccessKey',
    params: [
      {
        address: accessKey.accessKeyAddress,
        expiry: toSubscriptionExpirySeconds(toSubscriptionExpiryDate(request.subscriptionExpires)),
        keyType: accessKey.keyType,
        limits: [
          {
            token: request.currency as Address,
            limit: Hex.fromNumber(BigInt(request.amount)),
            period: toSubscriptionPeriodSeconds(request),
          },
        ],
        scopes: getSubscriptionScopes(request),
      },
    ],
  } as never)) as {
    keyAuthorization: Parameters<typeof KeyAuthorization.fromRpc>[0]
  }

  return KeyAuthorization.fromRpc(result.keyAuthorization)
}

function assertSubscriptionRequestRepresentable(request: SubscriptionRequest) {
  toSubscriptionPeriodSeconds(request)
  toSubscriptionExpirySeconds(toSubscriptionExpiryDate(request.subscriptionExpires))
}

export declare namespace subscription {
  /** Parameters for creating a Tempo subscription credential. */
  type Parameters = Account.getResolver.Parameters &
    Client.getResolver.Parameters & {
      accessKey?: SubscriptionAccessKey | undefined
      validateRequest?:
        | ((
            request: ReturnType<typeof Methods.subscription.schema.request.parse>,
          ) => MaybePromise<void>)
        | undefined
    }
}
