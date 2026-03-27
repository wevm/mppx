import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import { Json } from 'ox'
import { tempoModerato } from 'viem/chains'
import { type Plugin, defineConfig } from 'vite'

import * as Challenge from '../../../../Challenge.js'
import * as Credential from '../../../../Credential.js'
import * as Expires from '../../../../Expires.js'
import type * as Method from '../../../../Method.js'
import * as StripeMethods from '../../../../stripe/Methods.js'
import { createTokenResponse } from '../../../../stripe/server/internal/sharedPaymentToken.js'
import * as TempoMethods from '../../../../tempo/Methods.js'
import type * as z from '../../../../zod.js'
import {
  keyOf as composedKeyOf,
  renderComposedMethodContent,
  rootIdOf as composedRootIdOf,
} from '../../../internal/compose.js'
import {
  classNames,
  elements,
  support,
  supportPlaceholderOrigin,
  supportRequestUrl,
} from '../../../internal/constants.js'
import { renderDevScripts } from '../../../internal/dev.js'
import { renderHead } from '../../../internal/head.js'
import type * as Html from '../../../internal/types.js'

const pageDir = path.resolve(import.meta.dirname, '../..')

export default defineConfig({
  plugins: [
    {
      name: 'stripe-spt',
      configureServer(server) {
        // oxlint-disable-next-line no-async-endpoint-handlers
        server.middlewares.use(async (req, res, next) => {
          const url = new URL(req.url ?? '/', supportPlaceholderOrigin)
          if (
            url.searchParams.get(support.kind) !== support.action ||
            url.searchParams.get(support.actionName) !== 'createToken'
          )
            return next()

          const secretKey = process.env.VITE_STRIPE_SECRET_KEY
          if (!secretKey) {
            res.statusCode = 500
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ error: 'VITE_STRIPE_SECRET_KEY not set in .env' }))
            return
          }

          const chunks: Buffer[] = []
          for await (const chunk of req) chunks.push(chunk as Buffer)
          const response = await createTokenResponse({
            request: new Request(`${supportPlaceholderOrigin}${req.url ?? '/'}`, {
              body: Buffer.concat(chunks),
              method: req.method ?? 'POST',
            }),
            secretKey,
          })

          for (const [key, value] of response.headers) res.setHeader(key, value)
          res.statusCode = response.status
          res.end(await response.text())
        })
      },
    },
    devCompose({
      methods: [
        {
          method: StripeMethods.charge,
          challenge: {
            description: 'Test payment',
            request: {
              amount: '10',
              currency: 'usd',
              decimals: 2,
              networkId: 'acct_dev',
              paymentMethodTypes: ['card'],
            },
          },
          config: {
            publishableKey: process.env.VITE_STRIPE_PUBLIC_KEY ?? 'pk_test_example',
          },
        },
        {
          method: TempoMethods.charge,
          challenge: {
            description: 'Test payment',
            request: {
              amount: '1',
              currency: '0x20c0000000000000000000000000000000000001', // AlphaUSD
              decimals: 6,
              recipient: '0x0000000000000000000000000000000000000002',
              chainId: Number(process.env.TEMPO_CHAIN_ID ?? tempoModerato.id),
            },
          },
        },
      ],
    }),
  ],
})

type DevComposeMethodEntry<method extends Method.Method = Method.Method> = {
  method: method
  challenge: {
    request: z.input<method['schema']['request']>
    description?: string
    digest?: string | undefined
    expires?: string | undefined
    meta?: Record<string, string> | undefined
  }
  config?: Record<string, unknown>
}

function devCompose(options: {
  methods: DevComposeMethodEntry[]
  html?: Html.Config | undefined
  realm?: string | undefined
  secretKey?: string
}): Plugin {
  const realm = options.realm ?? 'localhost'
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
        const requestUrl = new URL(req.url ?? '/', supportPlaceholderOrigin)
        if (requestUrl.searchParams.get(support.kind) === support.serviceWorker) {
          const serviceWorker = await fs.readFile(
            path.resolve(pageDir, 'src/serviceWorker.ts'),
            'utf-8',
          )
          res.setHeader('Content-Type', 'application/javascript')
          const transformed = await server.transformRequest(
            '/@fs/' + path.resolve(pageDir, 'src/serviceWorker.ts'),
          )
          res.end(transformed?.code ?? serviceWorker)
          return
        }

        const pathname2 = req.url?.split('?')[0]
        if (pathname2 !== '/' || !req.headers.accept?.includes('text/html')) return next()

        try {
          const request = (await import('../../../../server/Request.js')).fromNodeListener(req, res)
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
          const challengeExpires =
            'expires' in entry.challenge ? entry.challenge.expires : Expires.minutes(5)
          const challenge = Challenge.fromMethod(entry.method, {
            description: entry.challenge.description,
            digest: entry.challenge.digest,
            secretKey,
            realm,
            request: entry.challenge.request,
            expires: challengeExpires,
            meta: entry.challenge.meta,
          })
          wwwAuthHeaders.push(Challenge.serialize(challenge))
          const intent = entry.method.intent
          const key = composedKeyOf(entry.method)
          challenges[key] = challenge
          const config = {
            ...entry.config,
            ...(entry.method.name === 'stripe'
              ? {
                  actions: {
                    createToken: supportRequestUrl({
                      kind: support.action,
                      method: key,
                      name: 'createToken',
                      url: `${supportPlaceholderOrigin}${req.url ?? '/'}`,
                    }),
                  },
                }
              : {}),
          }
          if (Object.keys(config).length > 0) configs[key] = config

          const methodDir = path.resolve(server.config.root, `../${entry.method.name}`)
          let htmlContent = ''
          try {
            htmlContent = (
              await fs.readFile(path.resolve(methodDir, `src/${intent}.html`), 'utf-8')
            ).trimEnd()
          } catch {}

          const rootId = composedRootIdOf(entry.method)
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
        const dataJson = Json.stringify({
          challenges,
          configs,
          config,
          support: {
            serviceWorkerUrl: supportRequestUrl({
              kind: support.serviceWorker,
              url: `${supportPlaceholderOrigin}${req.url ?? '/'}`,
            }),
          },
        }).replace(/</g, '\\u003c')

        // Build tab panels — each with its own external module script.
        // The transform hook injects __mppx_root/__mppx_active at the top of each
        // method module, so globals are set synchronously before any code runs.
        const methodContent = renderComposedMethodContent(
          methodEntries.map((method) => ({
            ...method,
            body: `<div id="${method.rootId}">${method.htmlContent}\n  <script type="module" src="${method.methodSrc}"></script></div>`,
          })),
        )

        const title = htmlConfig?.text?.title ?? 'Payment Required'
        const pageStyleHref = '/@fs/' + path.resolve(pageDir, 'src/page.css').replaceAll('\\', '/')
        const head = renderHead({
          title,
          theme: htmlConfig?.theme,
          assets: `\n  <link rel="stylesheet" href="${pageStyleHref}" />`,
        })

        const page = await fs.readFile(path.resolve(pageDir, 'src/page.html'), 'utf-8')
        const html = page
          .replace('<!--mppx:head-->', head)
          .replace(
            '<!--mppx:data-->',
            `<script id="${elements.data}" type="application/json">${dataJson}</script>`,
          )
          .replace('<!--mppx:script-->', renderDevScripts(pageDir))
          .replace(
            `<div class="${classNames.method}" id="${elements.method}"><!--mppx:method--></div>`,
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
