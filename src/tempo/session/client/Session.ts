import { type Account as ViemAccount, type Address, parseUnits } from 'viem'
import { tempo as tempo_chain } from 'viem/chains'

import type * as Challenge from '../../../Challenge.js'
import * as Constants from '../../../Constants.js'
import type { MaybePromise } from '../../../internal/types.js'
import * as Method from '../../../Method.js'
import * as Account from '../../../viem/Account.js'
import * as Client from '../../../viem/Client.js'
import * as defaults from '../../internal/defaults.js'
import * as Wallet from '../../internal/wallet.js'
import * as Methods from '../../Methods.js'
import { serializeCredential, type ChannelEntry } from './ChannelOps.js'
import { createChannelStore, type ChannelStore } from './ChannelStore.js'
import {
  type DescriptorSessionContext,
  executeCredentialPlan,
  planCredential,
  resolveChallengeContext,
  resolveRecoverContext,
  sessionContextSchema,
} from './CredentialState.js'

export { sessionContextSchema, type SessionContext } from './CredentialState.js'

/**
 * Resolved payment scope of a session challenge, plus the channel state already
 * known locally or hinted by the server, handed to {@link session.Parameters.resolveAccount}
 * so a wallet can choose which key signs vouchers for this scope.
 */
export type ResolveAccountInfo = {
  /** Default account resolved from method/context (the payer; usually a `json-rpc` root). */
  account: ViemAccount
  /** Chain ID the challenge settles on. */
  chainId: number
  /** Deserialized 402 challenge. */
  challenge: Challenge.Challenge
  /** Channel cached locally for this scope, when one exists. */
  entry?: ChannelEntry | undefined
  /** Escrow precompile the channel is opened against. */
  escrow: Address
  /** Payment-scope key (see {@link channelKey}). */
  key: string
  /** Payee (recipient) advertised by the challenge. */
  payee: Address
  /** Payer address (the default account's address). */
  payer: Address
  /** Descriptor recovery context derived from caller context or a server snapshot, when present. */
  recoverContext?: DescriptorSessionContext | undefined
  /** Token (currency) advertised by the challenge. */
  token: Address
}

/**
 * Resolves the account that signs vouchers for a session challenge. Return a
 * concrete account (e.g. a delegated access key) to sign with it, or `undefined`
 * to use the default {@link ResolveAccountInfo.account}.
 */
export type ResolveAccount = (info: ResolveAccountInfo) => MaybePromise<ViemAccount | undefined>

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
    channelStore,
    decimals = defaults.decimals,
    escrow: escrowOverride,
    getClient: getClientParameter,
    maxDeposit: maxDepositParameter,
    onChannelUpdate,
    resolveAccount,
  } = parameters
  const getClient = Client.getResolver({
    chain: tempo_chain,
    getClient: getClientParameter,
    rpcUrl: defaults.rpcUrl,
  })
  const getAccount = Account.getResolver({ account })
  const maxDeposit =
    maxDepositParameter !== undefined ? parseUnits(maxDepositParameter, decimals) : undefined
  const store = channelStore ?? createChannelStore()
  const sink = { store, notifyUpdate: (entry: ChannelEntry) => onChannelUpdate?.(entry) }
  // Positive-only memo of accounts/chains that already passed the wallet MPP
  // capability probe, so a supporting wallet is probed once per instance.
  const probeCache = new Map<string, true>()

  return Method.toClient(Methods.session, {
    canHandleChallenge({ challenge }) {
      return (
        Constants.getMethodDetail(
          challenge.request.methodDetails,
          Constants.MethodDetailKeys.sessionProtocol,
        ) === Constants.SessionProtocols.v2
      )
    },
    context: sessionContextSchema,
    async createCredential({ challenge, context }) {
      const resolved = await resolveChallengeContext({
        challenge,
        escrowOverride,
        getClient,
      })
      const account_default = getAccount(resolved.client, context)

      // Manual actions, caller-supplied channels, and challenges an opened
      // local channel can serve stay local (the wallet would strand its deposit).
      const manualContext =
        context?.action !== undefined ||
        context?.descriptor !== undefined ||
        context?.channelId !== undefined
      const entry = await store.get(resolved.key)
      const openedLocally = entry?.opened

      // Let the caller choose which key signs vouchers for this scope (e.g. a
      // delegated access key for resume, or a fresh-open key), given the channel
      // state already known locally or hinted by the server. `undefined` keeps
      // the default account. `planCredential` drops a resume/recover the resolved
      // account cannot sign for and opens fresh instead.
      const account =
        (await resolveAccount?.({
          account: account_default,
          chainId: resolved.chainId,
          challenge,
          entry,
          escrow: resolved.escrow,
          key: resolved.key,
          payee: resolved.payee,
          payer: account_default.address,
          recoverContext: resolveRecoverContext({ context, snapshot: resolved.snapshot }),
          token: resolved.token,
        })) ?? account_default

      // Wallet-native MPP: ask a JSON-RPC wallet to satisfy automatic-mode
      // challenges via `wallet_authorizeChallenge` before falling back to local planning.
      if (account.type === 'json-rpc' && !manualContext && !openedLocally) {
        const authorization = await Wallet.authorize(resolved.client, {
          account: account.address,
          chainId: resolved.chainId,
          challenge,
          probeCache,
        })
        if (authorization) return authorization
      }

      const payload = await executeCredentialPlan(
        planCredential({
          account,
          authorizedSigner,
          entry,
          context,
          decimals,
          maxDeposit,
          resolved,
        }),
        sink,
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
      /** Pluggable persistence for reusable channels. Defaults to an in-memory store. */
      channelStore?: ChannelStore | undefined
      /** Token decimals for parsing human-readable amounts (default: 6). */
      decimals?: number | undefined
      /** TIP20EscrowChannel address override. */
      escrow?: Address | undefined
      /** Maximum channel deposit in human-readable units. Caps server-suggested opens and automatic top-ups. */
      maxDeposit?: string | undefined
      /** Called whenever channel state changes. */
      onChannelUpdate?: ((entry: ChannelEntry) => void) | undefined
      /**
       * Resolves the account that signs vouchers for a given challenge scope,
       * letting a wallet pick a delegated access key (to resume without prompting
       * the root key, or to open a fresh channel) based on the local/server
       * channel state. Return `undefined` to use the default account.
       */
      resolveAccount?: ResolveAccount | undefined
    }
}
