import { Json } from 'ox'

import type * as Challenge from '../../Challenge.js'
import {
  keyOf as composedKeyOf,
  renderComposedMethodContent,
  rootIdOf as composedRootIdOf,
} from '../../html/internal/compose.js'
import { classNames, elements, support, supportRequestUrl } from '../../html/internal/constants.js'
import { renderHead, style } from '../../html/internal/head.js'
import type { Config, LightDark, Text, Theme } from '../../html/internal/types.js'
import type { MaybePromise } from '../../internal/types.js'
import { content, pageAssets, script, serviceWorker as serviceWorkerGen } from './html.gen.js'

export { classNames, elements, style }
export type { Config, LightDark, Text, Theme }

/** Service worker that injects a one-shot Authorization header on the next navigation. */
export const serviceWorker = {
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
  actions?:
    | Record<string, (request: globalThis.Request) => MaybePromise<globalThis.Response>>
    | undefined
  config?: Record<string, unknown> | undefined
  theme?: Theme | undefined
  text?: Text | undefined
}

export type Props = Options & {
  challenge: Challenge.Challenge
  requestUrl: string
}

export function render(props: Props): string {
  const title = props.text?.title ?? 'Payment Required'
  const data = Json.stringify({
    challenge: props.challenge,
    config: {
      ...buildConfig({
        actions: props.actions,
        config: props.config,
        requestUrl: props.requestUrl,
      }),
      ...(props.text ? { text: props.text } : {}),
      ...(props.theme ? { theme: props.theme } : {}),
    },
    support: { serviceWorkerUrl: serviceWorkerUrl(props.requestUrl) },
  }).replace(/</g, '\\u003c')
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
  actions?: Options['actions'] | undefined
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
  requestUrl: string
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
    const config = buildConfig({
      actions: m.actions,
      config: m.config,
      method: key,
      requestUrl: props.requestUrl,
    })
    if (Object.keys(config).length > 0) configs[key] = config
  }
  const config = {
    ...(props.text ? { text: props.text } : {}),
    ...(props.theme ? { theme: props.theme } : {}),
  }
  const data = Json.stringify({
    challenges,
    configs,
    config,
    support: { serviceWorkerUrl: serviceWorkerUrl(props.requestUrl) },
  }).replace(/</g, '\\u003c')

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

export type SupportRequest =
  | { kind: 'action'; method?: string | undefined; name: string }
  | { kind: 'serviceWorker' }

export function parseSupportRequest(request: globalThis.Request): SupportRequest | null {
  const url = new URL(request.url)
  const kind = url.searchParams.get(support.kind)
  if (kind === support.serviceWorker) return { kind: support.serviceWorker }
  if (kind !== support.action) return null
  const name = url.searchParams.get(support.actionName)
  if (!name) return null
  return {
    kind: support.action,
    method: url.searchParams.get(support.method) ?? undefined,
    name,
  }
}

export async function respondSupportRequest(parameters: {
  actions?: Options['actions'] | undefined
  request: globalThis.Request
}): Promise<globalThis.Response | null> {
  const { actions, request } = parameters
  const supportRequest = parseSupportRequest(request)
  if (!supportRequest) return null
  if (supportRequest.kind === support.serviceWorker)
    return new Response(serviceWorker.script, {
      headers: {
        'Cache-Control': 'no-store',
        'Content-Type': 'application/javascript',
      },
    })
  const handler = actions?.[supportRequest.name]
  if (!handler) return new Response('Not found', { status: 404 })
  return handler(request)
}

function buildConfig(parameters: {
  actions?: Options['actions'] | undefined
  config?: Record<string, unknown> | undefined
  method?: string | undefined
  requestUrl: string
}) {
  const { actions, config, method, requestUrl } = parameters
  const actionUrls = actions
    ? Object.fromEntries(
        Object.keys(actions).map((name) => [name, actionUrl({ method, name, requestUrl })]),
      )
    : undefined
  return {
    ...config,
    ...actionUrls,
  }
}

export function actionUrl(parameters: {
  method?: string | undefined
  name: string
  requestUrl: string
}): string {
  const { method, name, requestUrl } = parameters
  return supportRequestUrl({
    kind: support.action,
    method,
    name,
    url: requestUrl,
  })
}

export function serviceWorkerUrl(requestUrl: string): string {
  return supportRequestUrl({ kind: support.serviceWorker, url: requestUrl })
}
