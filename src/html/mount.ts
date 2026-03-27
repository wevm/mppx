import type { Challenge } from '../Challenge.js'
import type * as Method from '../Method.js'
import type * as z from '../zod.js'
import { classNames, elements } from './internal/constants.js'
import type * as Runtime from './internal/runtime.js'

export interface ShellState {
  amount: string
}

const browser = globalThis as typeof globalThis & {
  __mppx_scope?:
    | {
        key: string
        rootId: string
        runtime: Runtime.ScopedMppx
      }
    | undefined
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
  actions extends Record<string, string> = Runtime.Actions,
>(
  setup: (
    context: mount.Context<z.output<method['schema']['request']>, config, actions>,
  ) => void | Promise<void>,
): void {
  const scoped = browser.__mppx_scope?.runtime ?? browser.mppx
  const rootId = browser.__mppx_scope?.rootId ?? elements.method
  const root = document.getElementById(rootId)
  if (!root) throw new Error(`Missing root element: #${rootId}`)

  const methodKey = browser.__mppx_scope?.key
  const challenge = scoped.challenge
  const challenges = scoped.challenges
  const config = scoped.config as config
  const actionUrls = scoped.actions as actions
  const serializeCredential = scoped.serializeCredential.bind(scoped)

  const context: mount.Context<any, any, any> = {
    root,
    challenge,
    challenges,
    config,
    actions: actionUrls,
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
  type Context<
    request = Runtime.ChallengeRequest,
    config = Runtime.Config,
    actions = Runtime.Actions,
  > = {
    /** Root element for this method's UI. */
    root: HTMLElement
    /** Parsed challenge with typed request. */
    challenge: Challenge<request>
    /** All challenges, keyed by "name/intent" (composed pages). */
    challenges: Readonly<Record<string, Challenge<request>>> | undefined
    /** Method config passed from server. */
    config: config
    /** Route-local action URLs passed from the server. */
    actions: actions
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
