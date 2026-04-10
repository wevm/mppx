import { KeyAuthorization } from 'ox/tempo'
import type { Address } from 'viem'
import { tempo as tempo_chain } from 'viem/chains'
import { Actions } from 'viem/tempo'

import * as Credential from '../../Credential.js'
import * as Method from '../../Method.js'
import * as Account from '../../viem/Account.js'
import * as Client from '../../viem/Client.js'
import * as z from '../../zod.js'
import * as defaults from '../internal/defaults.js'
import * as Methods from '../Methods.js'

type AccessKeyReference = {
  accessKeyAddress: Address
  keyType: 'p256' | 'secp256k1' | 'webAuthn'
}

export const subscriptionContextSchema = z.object({
  accessKey: z.optional(z.custom<AccessKeyReference>()),
  account: z.optional(z.custom<Account.getResolver.Parameters['account']>()),
})

export type SubscriptionContext = z.infer<typeof subscriptionContextSchema>

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
      const chainId = challenge.request.methodDetails?.chainId ?? defaults.chainId.mainnet
      const client = await getClient({ chainId })
      const account = getAccount(client, context)
      const accessKey = context?.accessKey ?? parameters.accessKey
      if (!accessKey) {
        throw new Error(
          'No `accessKey` provided. Pass `accessKey` to parameters or context so the client knows which server key to authorize.',
        )
      }

      if (parameters.expectedRecipients) {
        const recipient = (challenge.request.recipient as string).toLowerCase()
        const allowed = parameters.expectedRecipients.map((address) => address.toLowerCase())
        if (!allowed.includes(recipient)) {
          throw new Error(`Unexpected subscription recipient: ${challenge.request.recipient}`)
        }
      }

      const periodSeconds = Number(challenge.request.periodSeconds)
      if (!Number.isSafeInteger(periodSeconds) || periodSeconds <= 0) {
        throw new Error('Subscription `periodSeconds` must be a positive safe integer.')
      }

      const keyAuthorization = await Actions.accessKey.signAuthorization(client, {
        account,
        accessKey,
        chainId,
        expiry: Math.floor(new Date(challenge.request.subscriptionExpires).getTime() / 1000),
        limits: [
          {
            token: challenge.request.currency as Address,
            limit: BigInt(challenge.request.amount),
            period: periodSeconds,
          },
        ],
        scopes: [
          {
            selectorRules: [
              {
                recipients: [challenge.request.recipient as Address],
                selector: '0xa9059cbb',
              },
              ...(parameters.allowMemo
                ? [
                    {
                      recipients: [challenge.request.recipient as Address],
                      selector: '0x95777d59',
                    },
                  ]
                : []),
            ],
            target: challenge.request.currency as Address,
          },
        ],
      } as never)

      return Credential.serialize({
        challenge,
        payload: {
          signature: KeyAuthorization.serialize(keyAuthorization as never),
          type: 'keyAuthorization',
        },
        source: `did:pkh:eip155:${chainId}:${account.address}`,
      })
    },
  })
}

export declare namespace subscription {
  type Parameters = Account.getResolver.Parameters &
    Client.getResolver.Parameters & {
      accessKey?: AccessKeyReference | undefined
      allowMemo?: boolean | undefined
      expectedRecipients?: readonly Address[] | undefined
    }
}
