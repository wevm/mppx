import { type Address, parseUnits } from 'viem'
import { tempo as tempo_chain } from 'viem/chains'

import * as Constants from '../../../Constants.js'
import * as Method from '../../../Method.js'
import * as Account from '../../../viem/Account.js'
import * as Client from '../../../viem/Client.js'
import * as defaults from '../../internal/defaults.js'
import * as Methods from '../../Methods.js'
import { serializeCredential, type ChannelEntry } from './ChannelOps.js'
import { sessionContextSchema } from './CredentialState.js'
import {
  createChannelCache,
  executeCredentialPlan,
  planCredential,
  resolveChallengeContext,
} from './CredentialState.js'

export { sessionContextSchema, type SessionContext } from './CredentialState.js'

/**
 * Creates the low-level TIP-1034 session payment method for use with `Mppx.create()`.
 *
 * Supports auto mode (server hints drive open/top-up sizing, with optional
 * `maxDeposit` as a local cap) and manual mode (`context.action` with a
 * channel descriptor).
 */
export function session(parameters: session.Parameters = {}) {
  const {
    account,
    authorizedSigner,
    decimals = defaults.decimals,
    escrow: escrowOverride,
    getClient: getClientParameter,
    maxDeposit: maxDepositParameter,
    onChannelUpdate,
  } = parameters
  const getClient = Client.getResolver({
    chain: tempo_chain,
    getClient: getClientParameter,
    rpcUrl: defaults.rpcUrl,
  })
  const getAccount = Account.getResolver({ account })
  const maxDeposit =
    maxDepositParameter !== undefined ? parseUnits(maxDepositParameter, decimals) : undefined
  const cache = createChannelCache(onChannelUpdate)

  return Method.toClient(Methods.session, {
    canHandleChallenge({ challenge }) {
      return (
        Constants.getMethodDetail(
          challenge.request.methodDetails,
          Constants.MethodDetailKeys.sessionProtocol,
        ) === Constants.SessionProtocols.tip1034
      )
    },
    context: sessionContextSchema,
    async createCredential({ challenge, context }) {
      const resolved = await resolveChallengeContext({
        challenge,
        escrowOverride,
        getClient,
      })
      const account = getAccount(resolved.client, context)
      const payload = await executeCredentialPlan(
        planCredential({
          account,
          authorizedSigner,
          cache,
          context,
          decimals,
          maxDeposit,
          resolved,
        }),
        cache,
      )
      return serializeCredential(challenge, payload, resolved.chainId, account)
    },
  })
}

/** Type helpers for the low-level TIP-1034 session client method. */
export declare namespace session {
  type Parameters = Account.getResolver.Parameters &
    Client.getResolver.Parameters & {
      /** Address authorized to sign vouchers on behalf of the payer. Defaults to the account access key address when available, otherwise the account address. */
      authorizedSigner?: Address | undefined
      /** Token decimals for parsing human-readable amounts (default: 6). */
      decimals?: number | undefined
      /** TIP20EscrowChannel address override. */
      escrow?: Address | undefined
      /** Maximum channel deposit in human-readable units. Caps server-suggested opens and automatic top-ups. */
      maxDeposit?: string | undefined
      /** Called whenever channel state changes. */
      onChannelUpdate?: ((entry: ChannelEntry) => void) | undefined
    }
}
