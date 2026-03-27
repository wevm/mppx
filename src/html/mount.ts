import type { Challenge } from '../Challenge.js'
import * as Credential from '../Credential.js'
import type * as Method from '../Method.js'
import type * as z from '../zod.js'
import { classNames, elements } from './internal/constants.js'
import type * as Runtime from './internal/runtime.js'

export interface ShellState {
  amount: string
}

const browser = globalThis as typeof globalThis & {
  __mppx_active?: string | undefined
  __mppx_root?: string | undefined
  mppx: Runtime.Mppx
}

/**
 * Mount a payment method's UI into the page shell.
 *
 * @example
 * ```ts
 * import { mount } from 'mppx/html'
 *
 * mount((c) => {
 *   const button = document.createElement('button')
 *   button.className = c.classNames.button
 *   button.textContent = 'Pay'
 *   button.onclick = () => c.dispatch({ token: '...' })
 *   c.root.appendChild(button)
 * })
 * ```
 */
export function mount<
  method extends Method.Method = Method.Method,
  config extends Record<string, unknown> = Runtime.Config,
>(
  setup: (
    context: mount.Context<z.output<method['schema']['request']>, config>,
  ) => void | Promise<void>,
): void {
  const rootId = browser.__mppx_root ?? elements.method
  const root = document.getElementById(rootId)
  if (!root) throw new Error(`Missing root element: #${rootId}`)

  const methodKey = browser.__mppx_active
  const challenge = browser.mppx.challenge
  const challenges = browser.mppx.challenges
  const config = browser.mppx.config

  function serializeCredential(payload: unknown, source?: string): string {
    return Credential.serialize({
      challenge,
      payload,
      ...(source ? { source } : {}),
    })
  }

  const context: mount.Context<any, any> = {
    root,
    challenge,
    challenges,
    config,
    dispatch: (payload, source) => {
      dispatchEvent(
        new CustomEvent('mppx:complete', { detail: serializeCredential(payload, source) }),
      )
    },
    serializeCredential,
    set<name extends keyof ShellState>(name: name, value: ShellState[name]) {
      const key = methodKey ?? Object.keys(challenges ?? {})[0] ?? 'unknown'
      dispatchEvent(new CustomEvent('mppx:set', { detail: { key, name, value } }))
    },
    classNames,
  }

  setup(context)
}

export declare namespace mount {
  type Context<request = Runtime.ChallengeRequest, config = Runtime.Config> = {
    /** Root element for this method's UI. */
    root: HTMLElement
    /** Parsed challenge with typed request. */
    challenge: Challenge<request>
    /** All challenges, keyed by "name/intent" (composed pages). */
    challenges: Readonly<Record<string, Challenge<request>>> | undefined
    /** Method config passed from server. */
    config: config
    /** Submit credential payload + optional source (payer identity). */
    dispatch(payload: unknown, source?: string): void
    /** Serialize a credential without dispatching. */
    serializeCredential(payload: unknown, source?: string): string
    /** Update shell UI values like the formatted amount. */
    set<name extends keyof ShellState>(name: name, value: ShellState[name]): void
    /** CSS class names for consistent styling with the page shell. */
    classNames: typeof classNames
  }
}
