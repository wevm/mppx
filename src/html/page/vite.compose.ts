import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import { tempoModerato } from 'viem/chains'
import { type Plugin, defineConfig } from 'vite'

import * as Challenge from '../../Challenge.js'
import * as Credential from '../../Credential.js'
import * as Expires from '../../Expires.js'
import type * as Method from '../../Method.js'
import * as Html from '../../server/Html.js'
import * as StripeMethods from '../../stripe/Methods.js'
import { createTokenPathname } from '../../stripe/server/Charge.js'
import * as TempoMethods from '../../tempo/Methods.js'
import type * as z from '../../zod.js'

const pageDir = import.meta.dirname

type DevComposeMethodEntry<method extends Method.Method = Method.Method> = {
  method: method
  request: z.input<method['schema']['request']>
  config?: Record<string, unknown>
  description?: string
}

function devCompose(options: {
  methods: DevComposeMethodEntry[]
  html?: Html.Config | undefined
  secretKey?: string
}): Plugin {
  const secretKey = options.secretKey ?? 'mppx-dev-secret'
  const htmlConfig = options.html

  // Map method entry scripts to their compose context (rootId, active key).
  // The `transform` hook prepends globals to the method module source so they
  // execute synchronously at the top of the module — before any imports or awaits.
  // This avoids the timing issue where separate <script type="module"> tags
  // run concurrently and overwrite shared globals.
  const composeContext = new Map<string, { rootId: string; key: string }>()

  return {
    name: 'mppx:dev-compose',
    transform(code, id) {
      // Inject compose preamble at the top of method entry modules.
      // Sets __mppx_root/__mppx_active, then creates a module-scoped `mppx` const
      // that shadows the global with eagerly-captured challenge/config values.
      // This prevents races where another method module overwrites __mppx_active
      // during an `await` (e.g. `await loadStripe()`).
      const ctx = composeContext.get(id)
      if (!ctx) return
      const preamble = [
        `window.__mppx_root="${ctx.rootId}";window.__mppx_active="${ctx.key}";`,
        `const mppx=Object.freeze({challenge:window.mppx.challenge,challenges:window.mppx.challenges,config:window.mppx.config,dispatch:window.mppx.dispatch.bind(window.mppx),serializeCredential:(p,s)=>{const _a=window.__mppx_active;window.__mppx_active="${ctx.key}";try{return window.mppx.serializeCredential(p,s)}finally{window.__mppx_active=_a}}});`,
      ].join('')
      return `${preamble}\n${code}`
    },
    configureServer(server) {
      // oxlint-disable-next-line no-async-endpoint-handlers
      server.middlewares.use(async (req, res, next) => {
        if (req.url === Html.serviceWorker.pathname) {
          const sw = await fs.readFile(path.resolve(pageDir, 'src/serviceWorker.ts'), 'utf-8')
          res.setHeader('Content-Type', 'application/javascript')
          const transformed = await server.transformRequest(
            '/@fs/' + path.resolve(pageDir, 'src/serviceWorker.ts'),
          )
          res.end(transformed?.code ?? sw)
          return
        }

        const pathname2 = req.url?.split('?')[0]
        if (pathname2 !== '/' || !req.headers.accept?.includes('text/html')) return next()

        try {
          const request = (await import('../../server/Request.js')).fromNodeListener(req, res)
          const credential = Credential.fromRequest(request)
          if (Challenge.verify(credential.challenge, { secretKey })) {
            res.setHeader('Content-Type', 'text/html')
            res.end(
              '<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><style>html{color-scheme:light dark}</style></head><body><h1>Payment verified!</h1><p>This is the protected content.</p></body></html>',
            )
            return
          }
        } catch {}

        const challenges: Record<string, unknown> = {}
        const configs: Record<string, Record<string, unknown>> = {}
        const wwwAuthHeaders: string[] = []
        const methodEntries: {
          key: string
          name: string
          intent: string
          rootId: string
          methodSrc: string
          htmlContent: string
        }[] = []

        for (const entry of options.methods) {
          const challenge = Challenge.fromMethod(entry.method, {
            description: entry.description,
            secretKey,
            realm: 'localhost',
            request: entry.request,
            expires: Expires.minutes(5),
          })
          wwwAuthHeaders.push(Challenge.serialize(challenge))
          const intent = entry.method.intent
          const key = `${entry.method.name}/${intent}`
          challenges[key] = challenge
          if (entry.config) configs[key] = entry.config

          const methodDir = path.resolve(server.config.root, `../${entry.method.name}`)
          let htmlContent = ''
          try {
            htmlContent = (
              await fs.readFile(path.resolve(methodDir, `src/${intent}.html`), 'utf-8')
            ).trimEnd()
          } catch {}

          const rootId = `${Html.elements.method}-${entry.method.name}-${intent}`
          const methodAbsPath = path.resolve(methodDir, `src/${intent}.ts`)
          const methodSrc = `/@fs/${methodAbsPath}`

          // Register compose context so the transform hook can inject the preamble
          composeContext.set(methodAbsPath, { rootId, key })

          methodEntries.push({
            key,
            name: entry.method.name,
            intent,
            rootId,
            methodSrc,
            htmlContent,
          })
        }

        // Build data JSON
        const config = {
          ...(htmlConfig?.text ? { text: htmlConfig.text } : {}),
          ...(htmlConfig?.theme ? { theme: htmlConfig.theme } : {}),
        }
        const dataJson = JSON.stringify({ challenges, configs, config }).replace(/</g, '\\u003c')

        // Build tab bar
        const tabBar = methodEntries
          .map((m, i) => {
            const panelId = `mppx-panel-${m.name}-${m.intent}`
            const tabId = `mppx-tab-${m.name}-${m.intent}`
            const cls = i === 0 ? Html.classNames.tabActive : Html.classNames.tab
            const selected = i === 0
            return `<button id="${tabId}" class="${cls}" role="tab" aria-selected="${selected}" aria-controls="${panelId}" tabindex="${selected ? 0 : -1}" data-method="${m.key}">${m.name}</button>`
          })
          .join('\n      ')

        // Build tab panels — each with its own external module script.
        // The transform hook injects __mppx_root/__mppx_active at the top of each
        // method module, so globals are set synchronously before any code runs.
        const panels = methodEntries
          .map((m, i) => {
            const panelId = `mppx-panel-${m.name}-${m.intent}`
            const tabId = `mppx-tab-${m.name}-${m.intent}`
            const hidden = i === 0 ? '' : ' hidden'
            return `<div id="${panelId}" class="${Html.classNames.tabPanel}" role="tabpanel" aria-labelledby="${tabId}" data-method="${m.key}"${hidden}>\n      <div id="${m.rootId}">${m.htmlContent}\n  <script type="module" src="${m.methodSrc}"></script></div>\n    </div>`
          })
          .join('\n    ')

        const methodContent = `<div class="${Html.classNames.tabs}" role="tablist" aria-label="Payment method">\n      ${tabBar}\n    </div>\n    ${panels}`

        const title = htmlConfig?.text?.title ?? 'Payment Required'
        const themeStyle = Html.style(htmlConfig?.theme)
        const head = `\n  <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n  <title>${title}</title>${themeStyle}`

        const page = await fs.readFile(path.resolve(pageDir, 'src/page.html'), 'utf-8')
        const html = page
          .replace('<!--mppx:head-->', head)
          .replace(
            '<!--mppx:data-->',
            `<script id="${Html.elements.data}" type="application/json">${dataJson}</script>`,
          )
          .replace(
            '<!--mppx:script-->',
            `<script type="module" src="/@fs/${path.resolve(pageDir, 'src/page.ts')}"></script>`,
          )
          .replace(
            `<div class="${Html.classNames.method}" id="${Html.elements.method}"><!--mppx:method--></div>`,
            methodContent,
          )

        const transformed = await server.transformIndexHtml(req.url!, html)
        res.setHeader('Content-Type', 'text/html; charset=utf-8')
        for (const h of wwwAuthHeaders) res.setHeader('WWW-Authenticate', h)
        res.setHeader('Cache-Control', 'no-store')
        res.statusCode = 402
        res.end(transformed)
      })
    },
  }
}

export default defineConfig({
  plugins: [
    {
      name: 'stripe-spt',
      configureServer(server) {
        // oxlint-disable-next-line no-async-endpoint-handlers
        server.middlewares.use(createTokenPathname, async (req, res) => {
          const secretKey = process.env.VITE_STRIPE_SECRET_KEY
          if (!secretKey) {
            res.statusCode = 500
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ error: 'VITE_STRIPE_SECRET_KEY not set in .env' }))
            return
          }

          const chunks: Buffer[] = []
          for await (const chunk of req) chunks.push(chunk as Buffer)
          const { paymentMethod, amount, currency, expiresAt } = JSON.parse(
            Buffer.concat(chunks).toString(),
          ) as { paymentMethod: string; amount: string; currency: string; expiresAt: number }

          const body = new URLSearchParams({
            payment_method: paymentMethod,
            'usage_limits[currency]': currency,
            'usage_limits[max_amount]': amount,
            'usage_limits[expires_at]': expiresAt.toString(),
          })

          const response = await fetch(
            'https://api.stripe.com/v1/test_helpers/shared_payment/granted_tokens',
            {
              method: 'POST',
              headers: {
                Authorization: `Basic ${btoa(`${secretKey}:`)}`,
                'Content-Type': 'application/x-www-form-urlencoded',
              },
              body,
            },
          )

          res.setHeader('Content-Type', 'application/json')
          if (!response.ok) {
            const error = (await response.json()) as { error: { message: string } }
            res.statusCode = 500
            res.end(JSON.stringify({ error: error.error.message }))
            return
          }

          const { id: spt } = (await response.json()) as { id: string }
          res.end(JSON.stringify({ spt }))
        })
      },
    },
    devCompose({
      methods: [
        {
          method: StripeMethods.charge,
          description: 'Test payment',
          request: {
            amount: '10',
            currency: 'usd',
            decimals: 2,
            networkId: 'acct_dev',
            paymentMethodTypes: ['card'],
          },
          config: {
            createTokenUrl: createTokenPathname,
            publishableKey: process.env.VITE_STRIPE_PUBLIC_KEY ?? 'pk_test_example',
          },
        },
        {
          method: TempoMethods.charge,
          description: 'Test payment',
          request: {
            amount: '1',
            currency: '0x20c0000000000000000000000000000000000001', // AlphaUSD
            decimals: 6,
            recipient: '0x0000000000000000000000000000000000000002',
            chainId: Number(process.env.TEMPO_CHAIN_ID ?? tempoModerato.id),
          },
        },
      ],
    }),
  ],
})
