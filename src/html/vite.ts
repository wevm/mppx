import * as crypto from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import { Json } from 'ox'
import type { Plugin } from 'vite'

import * as Challenge from '../Challenge.js'
import * as Credential from '../Credential.js'
import * as Expires from '../Expires.js'
import type * as Method from '../Method.js'
import type * as z from '../zod.js'
import { elements, serviceWorker as serviceWorkerRoute } from './internal/constants.js'
import { renderDevScripts } from './internal/dev.js'
import { renderHead } from './internal/head.js'
import type * as Html from './internal/types.js'

const pageDir = path.resolve(import.meta.dirname, 'page')

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
        if (req.url === serviceWorkerRoute.pathname) {
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
        const dataJson = Json.stringify({ challenge, config }).replace(/</g, '\\u003c')
        const pageStyleHref = '/@fs/' + path.resolve(pageDir, 'src/page.css').replaceAll('\\', '/')
        const head = renderHead({
          title,
          theme: htmlConfig?.theme,
          assets: `\n  <link rel="stylesheet" href="${pageStyleHref}" />`,
        })
        const page = await fs.readFile(path.resolve(pageDir, 'src/page.html'), 'utf-8')
        let methodContent = ''
        try {
          methodContent = (
            await fs.readFile(path.resolve(server.config.root, `src/${intent}.html`), 'utf-8')
          ).trimEnd()
        } catch {}

        const html = page
          .replace('<!--mppx:head-->', head)
          .replace(
            '<!--mppx:data-->',
            `<script id="${elements.data}" type="application/json">${dataJson}</script>`,
          )
          .replace('<!--mppx:script-->', renderDevScripts(pageDir))
          .replace(
            '<!--mppx:method-->',
            `${methodContent}\n  <script type="module" src="/src/${intent}.ts"></script>`,
          )

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
    config: () => ({
      build: {
        outDir: 'dist',
        emptyOutDir: true,
        rolldownOptions: {
          input: { [intent]: `src/${intent}.ts` },
          output: { entryFileNames: '[name].js', format: 'es' as const },
          ...({ codeSplitting: false } as {}),
        },
        modulePreload: false,
        minify: true,
      },
    }),
    configResolved(config) {
      root = config.root
    },
    async closeBundle() {
      const output = path.resolve(root, options.output)

      const assetsDir = path.resolve(root, 'dist/assets')
      const chunks: string[] = []
      try {
        for (const file of await fs.readdir(assetsDir)) {
          if (file.endsWith('.js'))
            chunks.push((await fs.readFile(path.resolve(assetsDir, file), 'utf-8')).trim())
        }
      } catch {}

      let content = ''
      try {
        content = (await fs.readFile(path.resolve(root, `src/${intent}.html`), 'utf-8')).trimEnd()
      } catch {}
      const entryScript = (
        await fs.readFile(path.resolve(root, `dist/${intent}.js`), 'utf-8')
      ).trim()
      const cleanedEntry = entryScript.replace(/^import\s.*?;\n?/gm, '')
      const allScripts = [...chunks, cleanedEntry].join('\n')
      const code = escapeTemplateLiteral(allScripts)
      const scriptBlock = `\n  <script type="module">\n${indent(code, 4)}\n  </script>`

      const body = [`export const html =`, `  \`\n${content}${scriptBlock}\n  \``].join('\n')
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
