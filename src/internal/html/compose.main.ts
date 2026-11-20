import { classNames, params } from './constants.js'

const tablist = document.querySelector<HTMLElement>(`.${classNames.tabList}`)!
const summary = document.querySelector<HTMLElement>(`.${classNames.summary}`)!
const amount = summary.querySelector<HTMLElement>(`.${classNames.summaryAmount}`)!
const tabs = Array.from(tablist.querySelectorAll<HTMLElement>('[role="tab"]'))

// Generate unique slugs: tempo, stripe, stripe-2
const slugs: string[] = []
const counts: Record<string, number> = {}
for (const tab of tabs) {
  const name = tab.textContent!.trim().toLowerCase()
  counts[name] = (counts[name] || 0) + 1
  slugs.push(counts[name] === 1 ? name : `${name}-${counts[name]}`)
}

function updateSummary(tab: HTMLElement) {
  amount.textContent = tab.dataset.amount!

  summary.querySelector(`.${classNames.summaryDescription}`)?.remove()
  if (tab.dataset.description) {
    const p = document.createElement('p')
    p.className = classNames.summaryDescription
    p.textContent = tab.dataset.description
    amount.after(p)
  }

  summary.querySelector(`.${classNames.summaryExpires}`)?.remove()
  if (tab.dataset.expires) {
    const p = document.createElement('p')
    p.className = classNames.summaryExpires
    const date = new Date(tab.dataset.expires)
    const time = document.createElement('time')
    time.dateTime = date.toISOString()
    time.textContent = date.toLocaleString()
    p.textContent = `${tab.dataset.expiresLabel} `
    p.appendChild(time)
    summary.appendChild(p)
  }
}

function activate(tab: HTMLElement, updateUrl = true) {
  tabs.forEach((t) => {
    t.setAttribute('aria-selected', 'false')
    t.setAttribute('tabindex', '-1')
  })
  tab.setAttribute('aria-selected', 'true')
  tab.removeAttribute('tabindex')
  tab.focus()
  document.querySelectorAll<HTMLElement>('[role="tabpanel"]').forEach((p) => {
    p.hidden = true
  })
  document.getElementById(tab.getAttribute('aria-controls')!)!.hidden = false

  updateSummary(tab)

  if (updateUrl) {
    const url = new URL(location.href)
    url.searchParams.set(params.tab, slugs[tabs.indexOf(tab)]!)
    history.replaceState(null, '', url)
  }
}

// Restore tab from URL on load
const initial = new URL(location.href).searchParams.get(params.tab)
if (initial !== null) {
  const index = slugs.indexOf(initial)
  if (index >= 0) activate(tabs[index]!, false)
}

tablist.addEventListener('click', (event) => {
  const tab = (event.target as HTMLElement).closest<HTMLElement>('[role="tab"]')
  if (tab) activate(tab)
})

tablist.addEventListener('keydown', (event) => {
  const index = tabs.indexOf(event.target as HTMLElement)
  if (index < 0) return
  let next: HTMLElement | undefined
  if (event.key === 'ArrowRight') next = tabs[(index + 1) % tabs.length]
  else if (event.key === 'ArrowLeft') next = tabs[(index - 1 + tabs.length) % tabs.length]
  else if (event.key === 'Home') next = tabs[0]
  else if (event.key === 'End') next = tabs[tabs.length - 1]
  if (next) {
    event.preventDefault()
    activate(next)
  }
})
