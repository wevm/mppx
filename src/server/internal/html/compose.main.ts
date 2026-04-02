const tablist = document.querySelector<HTMLElement>('.mppx-tablist')!
const param = '__mppx_tab'
const tabs = Array.from(tablist.querySelectorAll<HTMLElement>('[role="tab"]'))

// Generate unique slugs: tempo, stripe, stripe-2
const slugs: string[] = []
const counts: Record<string, number> = {}
for (const tab of tabs) {
  const name = tab.textContent!.trim().toLowerCase()
  counts[name] = (counts[name] || 0) + 1
  slugs.push(counts[name] === 1 ? name : `${name}-${counts[name]}`)
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

  if (updateUrl) {
    const url = new URL(location.href)
    url.searchParams.set(param, slugs[tabs.indexOf(tab)]!)
    history.replaceState(null, '', url)
  }
}

// Restore tab from URL on load
const initial = new URL(location.href).searchParams.get(param)
if (initial !== null) {
  const idx = slugs.indexOf(initial)
  if (idx >= 0) activate(tabs[idx]!, false)
}

tablist.addEventListener('click', (e) => {
  const tab = (e.target as HTMLElement).closest<HTMLElement>('[role="tab"]')
  if (tab) activate(tab)
})

tablist.addEventListener('keydown', (e) => {
  const idx = tabs.indexOf(e.target as HTMLElement)
  if (idx < 0) return
  let next: HTMLElement | undefined
  if (e.key === 'ArrowRight') next = tabs[(idx + 1) % tabs.length]
  else if (e.key === 'ArrowLeft') next = tabs[(idx - 1 + tabs.length) % tabs.length]
  else if (e.key === 'Home') next = tabs[0]
  else if (e.key === 'End') next = tabs[tabs.length - 1]
  if (next) {
    e.preventDefault()
    activate(next)
  }
})
