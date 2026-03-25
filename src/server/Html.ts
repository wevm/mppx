import type * as Challenge from '../Challenge.js'
import { content, script, serviceWorker } from './internal/html.gen.js'

/** Element ID for the JSON script tag containing challenge + config data. */
export const dataElementId = 'mppx-data'

/** Element ID for the method-specific content container. */
export const methodElementId = 'mppx-method'

/** Pathname for the service worker script endpoint. */
export const serviceWorkerPathname = '/__mppx_serviceWorker.js'

/** Service Worker script that injects a one-shot Authorization header on the next navigation. */
export const serviceWorkerScript = serviceWorker as string

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
  method?: string | undefined
  config?: Record<string, unknown> | undefined
}

export type Props = Options & {
  challenge: Challenge.Challenge
}

export function render(props: Props): string {
  const data = JSON.stringify({ challenge: props.challenge, config: props.config ?? {} })
  return content
    .replace('<!--mppx:head-->', head)
    .replace(
      '<!--mppx:data-->',
      `<script id="${dataElementId}" type="application/json">${data}</script>`,
    )
    .replace('<!--mppx:script-->', script)
    .replace(
      '<!--mppx:method-->',
      props.method ?? '  <p>This payment method does not support browser payments.</p>',
    )
}

const html = String.raw
const head = html`
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Payment Required</title>
  <style>
    html {
      color-scheme: light dark;
    }
  </style>
`
