import { Json } from 'ox'

import type * as Challenge from '../../Challenge.js'
import {
  keyOf as composedKeyOf,
  renderComposedMethodContent,
  rootIdOf as composedRootIdOf,
} from '../../html/internal/compose.js'
import {
  classNames,
  elements,
  serviceWorker as serviceWorkerRoute,
} from '../../html/internal/constants.js'
import { renderHead, style } from '../../html/internal/head.js'
import type { Config, LightDark, Text, Theme } from '../../html/internal/types.js'
import { content, pageAssets, script, serviceWorker as serviceWorkerGen } from './html.gen.js'

export { classNames, elements, style }
export type { Config, LightDark, Text, Theme }

/** Service worker that injects a one-shot Authorization header on the next navigation. */
export const serviceWorker = {
  pathname: serviceWorkerRoute.pathname,
  script: serviceWorkerGen as string,
} as const

/**
 * Renders a self-contained HTML payment page for a 402 challenge.
 *
 * Replaces comment slots in the page template:
 * - `<!--mppx:head-->` — viewport, title, and styles
 * - `<!--mppx:data-->` — challenge + config JSON
 * - `<!--mppx:script-->` — bundled page script
 * - `<!--mppx:method-->` — method-specific HTML
 */
export type Options = {
  /** Method-specific HTML content. Must be from a trusted source (e.g. build-time generated `html.gen.ts`). */
  content: string
  config?: Record<string, unknown> | undefined
  theme?: Theme | undefined
  text?: Text | undefined
}

export type Props = Options & {
  challenge: Challenge.Challenge
}

export function render(props: Props): string {
  const title = props.text?.title ?? 'Payment Required'
  const config = {
    ...props.config,
    ...(props.text ? { text: props.text } : {}),
    ...(props.theme ? { theme: props.theme } : {}),
  }
  const data = Json.stringify({ challenge: props.challenge, config }).replace(/</g, '\\u003c')
  const head = renderHead({ title, theme: props.theme, assets: pageAssets })
  return content
    .replace('<!--mppx:head-->', head)
    .replace(
      '<!--mppx:data-->',
      `<script id="${elements.data}" type="application/json">${data}</script>`,
    )
    .replace('<!--mppx:script-->', script)
    .replace('<!--mppx:method-->', props.content)
}

/** A method entry for composed (multi-method) rendering. */
export type ComposedMethod = {
  name: string
  intent: string
  challenge: Challenge.Challenge
  content: string
  config?: Record<string, unknown> | undefined
}

/**
 * Renders a multi-method HTML payment page with tabs.
 *
 * Each method gets its own tab panel with a scoped root element.
 * Method scripts are prepended with `__mppx_root` and `__mppx_active`
 * assignments so each module initializes with the correct context.
 */
export function compose(props: {
  methods: readonly ComposedMethod[]
  theme?: Theme | undefined
  text?: Text | undefined
}): string {
  const { methods } = props
  const title = props.text?.title ?? 'Payment Required'

  // Build data: challenges + configs keyed by "name/intent"
  const challenges: Record<string, Challenge.Challenge> = {}
  const configs: Record<string, Record<string, unknown>> = {}
  for (const m of methods) {
    const key = composedKeyOf(m)
    challenges[key] = m.challenge
    if (m.config) configs[key] = m.config
  }
  const config = {
    ...(props.text ? { text: props.text } : {}),
    ...(props.theme ? { theme: props.theme } : {}),
  }
  const data = Json.stringify({ challenges, configs, config }).replace(/</g, '\\u003c')

  const methodContent = renderComposedMethodContent(
    methods.map((method) => {
      const key = composedKeyOf(method)
      const rootId = composedRootIdOf(method)
      // Inject __mppx_root and __mppx_active before the method's module script.
      // The method html contains an inline <script type="module"> — we prepend
      // assignments inside it so they execute at the top of that module.
      const patchedHtml = method.content.replace(
        '<script type="module">',
        `<script type="module">window.__mppx_root="${rootId}";window.__mppx_active="${key}";`,
      )
      return {
        ...method,
        body: `<div id="${rootId}">${patchedHtml}</div>`,
      }
    }),
  )

  const head = renderHead({ title, theme: props.theme, assets: pageAssets })
  return content
    .replace('<!--mppx:head-->', head)
    .replace(
      '<!--mppx:data-->',
      `<script id="${elements.data}" type="application/json">${data}</script>`,
    )
    .replace('<!--mppx:script-->', script)
    .replace(
      `<div class="${classNames.method}" id="${elements.method}"><!--mppx:method--></div>`,
      methodContent,
    )
}
