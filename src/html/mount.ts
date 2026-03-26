import type { Challenge } from '../Challenge.js'
import { classNames, elements } from '../server/Html.js'

export type MountContext<request = MppxChallengeRequest, config = MppxConfig> = {
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
  /** Update the formatted amount shown in the page shell header. */
  setAmount(formatted: string): void
  /** CSS class names for consistent styling with the page shell. */
  classNames: typeof classNames
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
  method extends import('../Method.js').Method = import('../Method.js').Method,
  config extends Record<string, unknown> = MppxConfig,
>(
  setup: (
    context: MountContext<import('../zod.js').output<method['schema']['request']>, config>,
  ) => void | Promise<void>,
): void {
  const root = document.getElementById(window.__mppx_root ?? elements.method)
  if (!root) throw new Error(`Missing root element: #${window.__mppx_root ?? elements.method}`)

  const methodKey = window.__mppx_active

  const context: MountContext<any, any> = {
    root,
    challenge: mppx.challenge,
    challenges: mppx.challenges,
    config: mppx.config,
    dispatch: (payload, source) => mppx.dispatch(payload, source),
    serializeCredential: (payload, source) => mppx.serializeCredential(payload, source),
    setAmount(formatted: string) {
      const key = methodKey ?? Object.keys(mppx.challenges ?? {})[0] ?? 'unknown'
      dispatchEvent(new CustomEvent('mppx:amount', { detail: { key, amount: formatted } }))
    },
    classNames,
  }

  setup(context)
}

export { classNames, elements }
