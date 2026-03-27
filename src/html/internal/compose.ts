import { classNames, elements } from './constants.js'

type MethodLike = {
  name: string
  intent: string
}

export type ComposedShellEntry = MethodLike & {
  body: string
}

export function keyOf(method: MethodLike): string {
  return `${method.name}/${method.intent}`
}

export function rootIdOf(method: MethodLike): string {
  return `${elements.method}-${method.name}-${method.intent}`
}

export function panelIdOf(method: MethodLike): string {
  return `mppx-panel-${method.name}-${method.intent}`
}

export function tabIdOf(method: MethodLike): string {
  return `mppx-tab-${method.name}-${method.intent}`
}

export function renderComposedMethodContent(methods: readonly ComposedShellEntry[]): string {
  const tabBar = methods
    .map((method, index) => {
      const key = keyOf(method)
      const panelId = panelIdOf(method)
      const tabId = tabIdOf(method)
      const isSelected = index === 0
      const className = isSelected ? classNames.tabActive : classNames.tab
      return `<button type="button" id="${tabId}" class="${className}" role="tab" aria-selected="${isSelected}" aria-controls="${panelId}" tabindex="${isSelected ? 0 : -1}" data-method="${key}">${method.name}</button>`
    })
    .join('\n      ')

  const panels = methods
    .map((method, index) => {
      const key = keyOf(method)
      const panelId = panelIdOf(method)
      const tabId = tabIdOf(method)
      const hidden = index === 0 ? '' : ' hidden'
      return `<div id="${panelId}" class="${classNames.tabPanel}" role="tabpanel" tabindex="0" aria-labelledby="${tabId}" data-method="${key}"${hidden}>\n      ${method.body}\n    </div>`
    })
    .join('\n    ')

  return `<div class="${classNames.tabs}" role="tablist" aria-label="Payment method">\n      ${tabBar}\n    </div>\n    ${panels}`
}
