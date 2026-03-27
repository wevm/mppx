import { Json } from 'ox'

import type * as Challenge from '../../Challenge.js'
import { elements } from './constants.js'
import type * as Runtime from './runtime.js'

export type MethodData = {
  challenge: Challenge.Challenge
  config?: Runtime.Config | undefined
  actions?: Runtime.Actions | undefined
}

export type Data = {
  method?: MethodData | undefined
  methods?: Record<string, MethodData> | undefined
  shell?: Runtime.Shell | undefined
  support: {
    serviceWorkerUrl: string
  }
}

export function renderPage(parameters: {
  template: string
  head: string
  data: Data
  scripts: string
  methodContent: string
}): string {
  const { data, head, methodContent, scripts, template } = parameters
  const dataJson = Json.stringify(data).replace(/</g, '\\u003c')
  return template
    .replace('<!--mppx:head-->', head)
    .replace(
      '<!--mppx:data-->',
      `<script id="${elements.data}" type="application/json">${dataJson}</script>`,
    )
    .replace('<!--mppx:script-->', scripts)
    .replace('<!--mppx:method-->', methodContent)
}

export type Scope = {
  key: string
  rootId: string
}

export function scopedRuntimePreamble(scope: Scope): string {
  return [
    `const mppx=window.mppx.scope(${JSON.stringify(scope.key)});`,
    `window.__mppx_scope={key:${JSON.stringify(scope.key)},rootId:${JSON.stringify(scope.rootId)},runtime:mppx};`,
  ].join('')
}

export function prependScopedRuntime(parameters: { html: string; scope: Scope }): string {
  const { html, scope } = parameters
  const needle = '<script type="module">'
  if (!html.includes(needle)) return html
  return html.replace(needle, `${needle}${scopedRuntimePreamble(scope)}`)
}
