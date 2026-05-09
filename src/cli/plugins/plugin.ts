import type * as Challenge from '../../Challenge.js'
import type * as Method from '../../Method.js'
import type { Network } from '../utils.js'

export function createPlugin(plugin: Plugin): Plugin {
  return plugin
}

export interface Plugin {
  /** Payment method name (e.g., 'tempo', 'stripe') */
  method: string

  /** Optional predicate for challenge support when a plugin does not support every intent for its method. */
  supports?(challenge: Challenge.Challenge): boolean

  /**
   * Resolve account, client, and display info for a challenge.
   * Returns methods for credential creation.
   */
  setup(ctx: {
    challenge: Challenge.Challenge
    options: {
      account?: string | undefined
      network?: Network | undefined
      rpcUrl?: string | undefined
    }
    methodOpts: Record<string, string>
  }): Promise<{
    /** Token symbol for display (e.g., 'PathUSD', 'USD') */
    tokenSymbol: string
    /** Token decimals for display */
    tokenDecimals: number
    /** Block explorer URL for links */
    explorerUrl?: string | undefined
    /** Client methods for credential creation */
    methods: Method.AnyClient[]
    /** Optional context to pass to createCredential */
    credentialContext?: unknown
    /** Override credential creation entirely (e.g., delegating to an external CLI) */
    createCredential?: ((response: Response) => Promise<string>) | undefined
  }>

  /**
   * Modify the credential request before sending.
   * Called after credential creation, before the fetch with Authorization header.
   * Plugins can add headers (e.g., Accept: text/event-stream for sessions).
   */
  prepareCredentialRequest?(ctx: {
    challenge: Challenge.Challenge
    credential: string
    headers: Record<string, string>
  }): void

  /**
   * Handle the full post-credential response lifecycle.
   * Return `true` if fully handled (caller skips default body printing).
   * Return `false` or leave unimplemented for default behavior (print body).
   */
  handleResponse?(ctx: ResponseContext): Promise<boolean>

  /** Format a receipt field for display. Return undefined to use default formatting. */
  formatReceiptField?(key: string, value: unknown): string | undefined
}

/** Context passed to handleResponse */
export interface ResponseContext {
  challenge: Challenge.Challenge
  credential: string
  response: Response
  fetchUrl: string
  fetchInit: RequestInit
  silent: boolean
  verbose: number
  confirmEnabled: boolean
  confirm: (msg: string, defaultYes?: boolean) => Promise<boolean>
  tokenSymbol: string
  tokenDecimals: number
  explorerUrl?: string | undefined
  /** Keys already shown in the challenge display (to avoid duplicating in receipts) */
  shownKeys: Set<string>
}
