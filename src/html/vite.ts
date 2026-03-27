import * as crypto from 'node:crypto'
import { existsSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import { Json } from 'ox'
import type { Plugin } from 'vite'

import * as Challenge from '../Challenge.js'
import * as Credential from '../Credential.js'
import * as Expires from '../Expires.js'
import type * as Method from '../Method.js'
import type * as z from '../zod.js'
import {
  elements,
  support,
  supportPlaceholderOrigin,
  supportRequestUrl,
} from './internal/constants.js'
import { renderDevScripts } from './internal/dev.js'
import { renderHead } from './internal/head.js'
import type * as Html from './internal/types.js'

const pageDir = path.resolve(import.meta.dirname, 'page')
const emptyEntryId = '\0mppx:empty-entry'

type Config<method extends Method.Method = Method.Method> = {
  /** The method schema (e.g. Methods.charge). Used to derive entry name from method.intent. */
  method: method
  /** Output path for html.gen.ts, relative to Vite root. */
  output: string
  /** Challenge data for the dev server. Only used during `vite dev`. */
  challenge?: {
    request?: z.input<method['schema']['request']>
    description?: string
    digest?: string | undefined
    expires?: string | undefined
    meta?: Record<string, string> | undefined
  }
  /** Method config passed to MppxConfig in the page (e.g. { publishableKey }). */
  config?: Record<string, unknown>
  /** Visual configuration for the page shell. */
  html?: Html.Config | undefined
  /** Server realm for dev challenges. Defaults to 'localhost'. */
  realm?: string | undefined
  /** Secret key for HMAC-bound challenge IDs. Defaults to 'mppx-dev-secret'. */
  secretKey?: string
}

export default function mppx<const method extends Method.Method>(
  options: Config<method>,
): Plugin[] {
  const intent = options.method.intent
  const realm = options.realm ?? 'localhost'
  const secretKey = options.secretKey ?? 'mppx-dev-secret'
  const htmlConfig = options.html
  const challengeOptions = options.challenge
  const challengeRequest = challengeOptions?.request
  const challengeExpires =
    challengeOptions && 'expires' in challengeOptions
      ? challengeOptions.expires
      : Expires.minutes(5)
  let entrypoints: ReturnType<typeof resolveEntrypoints> | undefined

  const devPlugin: Plugin = {
    name: 'mppx:dev',
    apply: 'serve',
    configureServer(server) {
      if (!challengeRequest) {
        throw new Error(
          'mppx: "challenge.request" is required for dev mode. Add it to your mppx() plugin options.',
        )
      }

      // oxlint-disable-next-line no-async-endpoint-handlers
      server.middlewares.use(async (req, res, next) => {
        const requestUrl = new URL(req.url ?? '/', supportPlaceholderOrigin)
        if (requestUrl.searchParams.get(support.kind) === support.serviceWorker) {
          const sw = await fs.readFile(path.resolve(pageDir, 'src/serviceWorker.ts'), 'utf-8')
          res.setHeader('Content-Type', 'application/javascript')
          const transformed = await server.transformRequest(
            '/@fs/' + path.resolve(pageDir, 'src/serviceWorker.ts'),
          )
          res.end(transformed?.code ?? sw)
          return
        }

        const pathname = req.url?.split('?')[0]
        if (pathname !== '/' || !req.headers.accept?.includes('text/html')) return next()

        try {
          const request = (await import('../server/Request.js')).fromNodeListener(req, res)
          const credential = Credential.fromRequest(request)
          const parsedPayload = options.method.schema.credential.payload.safeParse(
            credential.payload,
          )
          // Dev mode should only accept credentials that match the method schema,
          // otherwise fixture tests can pass without any server-side payload validation.
          if (Challenge.verify(credential.challenge, { secretKey }) && parsedPayload.success) {
            res.setHeader('Content-Type', 'text/html')
            res.end(
              '<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><style>html{color-scheme:light dark}</style></head><body><h1>Payment verified!</h1><p>This is the protected content.</p></body></html>',
            )
            return
          }
        } catch {}

        const challenge = Challenge.fromMethod(options.method, {
          description: challengeOptions.description,
          digest: challengeOptions.digest,
          secretKey,
          realm,
          request: challengeRequest,
          expires: challengeExpires,
          meta: challengeOptions.meta,
        })

        const title = htmlConfig?.text?.title ?? 'Payment Required'
        const config = {
          ...options.config,
          ...(htmlConfig?.text ? { text: htmlConfig.text } : {}),
          ...(htmlConfig?.theme ? { theme: htmlConfig.theme } : {}),
        }
        const dataJson = Json.stringify({
          challenge,
          config,
          support: {
            serviceWorkerUrl: supportRequestUrl({
              kind: support.serviceWorker,
              url: `${supportPlaceholderOrigin}${req.url ?? '/'}`,
            }),
          },
        }).replace(/</g, '\\u003c')
        const pageStyleHref = '/@fs/' + path.resolve(pageDir, 'src/page.css').replaceAll('\\', '/')
        const head = renderHead({
          title,
          theme: htmlConfig?.theme,
          assets: `\n  <link rel="stylesheet" href="${pageStyleHref}" />`,
        })
        const page = await fs.readFile(path.resolve(pageDir, 'src/page.html'), 'utf-8')
        const entrypoints = resolveEntrypoints(server.config.root, intent)
        assertEntrypoints(entrypoints, intent)
        let methodContent = ''
        if (entrypoints.html)
          methodContent = (await fs.readFile(entrypoints.html, 'utf-8')).trimEnd()
        const methodScript = entrypoints.script
          ? `\n  <script type="module" src="/src/${intent}.ts"></script>`
          : ''

        const html = page
          .replace('<!--mppx:head-->', head)
          .replace(
            '<!--mppx:data-->',
            `<script id="${elements.data}" type="application/json">${dataJson}</script>`,
          )
          .replace('<!--mppx:script-->', renderDevScripts(pageDir))
          .replace('<!--mppx:method-->', `${methodContent}${methodScript}`)

        const transformed = await server.transformIndexHtml(req.url!, html)
        res.setHeader('Content-Type', 'text/html; charset=utf-8')
        res.setHeader('WWW-Authenticate', Challenge.serialize(challenge))
        res.setHeader('Cache-Control', 'no-store')
        res.statusCode = 402
        res.end(transformed)
      })
    },
  }

  let root: string

  const buildPlugin: Plugin = {
    name: 'mppx:build',
    apply: 'build',
    config(config) {
      const root = path.resolve(config.root ?? process.cwd())
      entrypoints = resolveEntrypoints(root, intent)
      assertEntrypoints(entrypoints, intent)
      return {
        build: {
          outDir: 'dist',
          emptyOutDir: true,
          rolldownOptions: {
            input: { [intent]: entrypoints.script ? `src/${intent}.ts` : emptyEntryId },
            output: {
              entryFileNames: '[name].js',
              format: 'es' as const,
              ...({ codeSplitting: false } as {}),
            },
          },
          modulePreload: false,
          minify: true,
        },
      }
    },
    resolveId(id) {
      if (id === emptyEntryId) return id
    },
    load(id) {
      if (id === emptyEntryId) return ''
    },
    configResolved(config) {
      root = config.root
      entrypoints = resolveEntrypoints(root, intent)
    },
    async closeBundle() {
      const output = path.resolve(root, options.output)
      assertEntrypoints(entrypoints, intent)

      const assetsDir = path.resolve(root, 'dist/assets')
      const chunks: string[] = []
      const styles: string[] = []
      try {
        for (const file of await fs.readdir(assetsDir)) {
          if (file.endsWith('.js'))
            chunks.push((await fs.readFile(path.resolve(assetsDir, file), 'utf-8')).trim())
          if (file.endsWith('.css'))
            styles.push((await fs.readFile(path.resolve(assetsDir, file), 'utf-8')).trim())
        }
      } catch {}

      let content = ''
      if (entrypoints.html) content = (await fs.readFile(entrypoints.html, 'utf-8')).trimEnd()

      let cleanedEntry = ''
      if (entrypoints.script) {
        const entryScript = (
          await fs.readFile(path.resolve(root, `dist/${intent}.js`), 'utf-8')
        ).trim()
        cleanedEntry = entryScript.replace(/^import\s?.*?;\n?/gm, '')
      }

      const allStyles = styles.filter(Boolean).join('\n')
      const allScripts = [...chunks, cleanedEntry].filter(Boolean).join('\n')
      const styleBlock = allStyles
        ? `<style>\n${indent(escapeTemplateLiteral(allStyles), 4)}\n  </style>`
        : ''
      const scriptBlock = allScripts
        ? `<script type="module">\n${indent(escapeTemplateLiteral(allScripts), 4)}\n  </script>`
        : ''

      const html = [content, styleBlock, scriptBlock].filter(Boolean).join('\n')

      const body = [`export const html =`, `  \`\n${html}\n  \``].join('\n')
      const file = [comment(body), ``, body].join('\n')

      await fs.mkdir(path.dirname(output), { recursive: true })
      await fs.writeFile(output, file + '\n')
      console.log(`  Wrote ${output}`)
    },
  }

  return [devPlugin, buildPlugin]
}

function comment(body: string): string {
  const hash = crypto.createHash('md5').update(body).digest('hex')
  return `/* oxlint-disable */\n// Generated by \`pnpm build:html\` (hash: ${hash})`
}

function escapeTemplateLiteral(str: string): string {
  return str
    .replace(/\/\/# sourceMappingURL=.*$/m, '')
    .trim()
    .replaceAll('\\', '\\\\')
    .replaceAll('`', '\\`')
    .replaceAll('${', '\\${')
}

function indent(str: string, spaces: number): string {
  const pad = ' '.repeat(spaces)
  return str
    .split('\n')
    .map((line) => (line.trim() ? pad + line : line))
    .join('\n')
}

function resolveEntrypoints(root: string, intent: string) {
  const html = path.resolve(root, `src/${intent}.html`)
  const script = path.resolve(root, `src/${intent}.ts`)
  return {
    html: existsSync(html) ? html : undefined,
    script: existsSync(script) ? script : undefined,
  }
}

function assertEntrypoints(
  entrypoints: { html?: string | undefined; script?: string | undefined } | undefined,
  intent: string,
): asserts entrypoints is { html?: string | undefined; script?: string | undefined } {
  if (entrypoints?.html || entrypoints?.script) return
  throw new Error(`mppx: expected src/${intent}.ts or src/${intent}.html`)
}
