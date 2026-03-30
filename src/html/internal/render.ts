import { Json } from 'ox'

import type * as Challenge from '../../Challenge.js'
import { classNames, elements } from './constants.js'
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
  const challenge = data.method?.challenge ?? Object.values(data.methods ?? {})[0]?.challenge
  return template
    .replace('<!--mppx:head-->', head)
    .replace(
      '<!--mppx:data-->',
      `<script id="${elements.data}" type="application/json">${dataJson}</script>`,
    )
    .replace('<!--mppx:summary-->', renderSummary(challenge))
    .replace('<!--mppx:script-->', scripts)
    .replace('<!--mppx:method-->', methodContent)
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function renderSummary(challenge: Challenge.Challenge | undefined): string {
  if (!challenge) return ''
  const amount = `<div class="${classNames.summaryAmount}" style="opacity:0">0</div>`
  const description = `<p class="${classNames.description}">${challenge.description ? escapeHtml(challenge.description) : ''}</p>`
  const expires = `<p class="${classNames.summaryLabel}">${challenge.expires ? 'Expires at' : ''}</p>`
  return `${amount}${description}${expires}`
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
