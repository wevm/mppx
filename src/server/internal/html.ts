import type * as Challenge from '../../Challenge.js'
import {
  keyOf as composedKeyOf,
  renderComposedMethodContent,
  rootIdOf as composedRootIdOf,
} from '../../html/internal/compose.js'
import { classNames, elements, support, supportRequestUrl } from '../../html/internal/constants.js'
import { renderHead, style } from '../../html/internal/head.js'
import { prependScopedRuntime, renderPage } from '../../html/internal/render.js'
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
  const actions = buildActions({ actions: props.actions, requestUrl: props.requestUrl })
  const data = {
    method: {
      challenge: props.challenge,
      ...(props.config ? { config: props.config } : {}),
      ...(actions ? { actions } : {}),
    },
    ...(props.text || props.theme
      ? {
          shell: {
            ...(props.text ? { text: props.text } : {}),
            ...(props.theme ? { theme: props.theme } : {}),
          },
        }
      : {}),
    support: { serviceWorkerUrl: serviceWorkerUrl(props.requestUrl) },
  }
  const head = renderHead({ title, theme: props.theme, assets: pageAssets })
  return renderPage({
    template: content,
    head,
    data,
    scripts: script,
    methodContent: props.content,
  })
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

  const pageMethods: Record<
    string,
    {
      challenge: Challenge.Challenge
      config?: Record<string, unknown>
      actions?: Record<string, string>
    }
  > = {}
  for (const m of methods) {
    const key = composedKeyOf(m)
    const actions = buildActions({
      actions: m.actions,
      method: key,
      requestUrl: props.requestUrl,
    })
    pageMethods[key] = {
      challenge: m.challenge,
      ...(m.config ? { config: m.config } : {}),
      ...(actions ? { actions } : {}),
    }
  }
  const data = {
    methods: pageMethods,
    ...(props.text || props.theme
      ? {
          shell: {
            ...(props.text ? { text: props.text } : {}),
            ...(props.theme ? { theme: props.theme } : {}),
          },
        }
      : {}),
    support: { serviceWorkerUrl: serviceWorkerUrl(props.requestUrl) },
  }

  const methodContent = renderComposedMethodContent(
    methods.map((method) => {
      const key = composedKeyOf(method)
      const rootId = composedRootIdOf(method)
      const patchedHtml = prependScopedRuntime({
        html: method.content,
        scope: { key, rootId },
      })
      return {
        ...method,
        body: `<div id="${rootId}">${patchedHtml}</div>`,
      }
    }),
  )

  const head = renderHead({ title, theme: props.theme, assets: pageAssets })
  return renderPage({
    template: content,
    head,
    data,
    scripts: script,
    methodContent,
  })
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

function buildActions(parameters: {
  actions?: Options['actions'] | undefined
  method?: string | undefined
  requestUrl: string
}) {
  const { actions, method, requestUrl } = parameters
  if (!actions) return undefined
  return Object.fromEntries(
    Object.keys(actions).map((name) => [name, actionUrl({ method, name, requestUrl })]),
  )
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
