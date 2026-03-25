import * as crypto from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import type { Plugin } from 'vite'

import * as Challenge from '../Challenge.js'
import * as Credential from '../Credential.js'
import * as Expires from '../Expires.js'
import type * as Method from '../Method.js'
import { dataElementId, serviceWorkerPathname } from '../server/Html.js'
import type * as z from '../zod.js'

const html = String.raw
const pageDir = path.resolve(import.meta.dirname, 'page')
const defaultHead = html`
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Payment Required</title>
  <style>
    html {
      color-scheme: light dark;
    }
  </style>
`

export function dev<const method extends Method.Method>(options: {
  method: method
  request: z.input<method['schema']['request']>
  config?: Record<string, unknown>
  secretKey?: string
}): Plugin {
  const secretKey = options.secretKey ?? 'mppx-dev-secret'
  return {
    name: 'mppx:dev',
    configureServer(server) {
      const intent = options.method.intent

      // oxlint-disable-next-line no-async-endpoint-handlers
      server.middlewares.use(async (req, res, next) => {
        if (req.url === serviceWorkerPathname) {
          const sw = await fs.readFile(path.resolve(pageDir, 'src/serviceWorker.ts'), 'utf-8')
          res.setHeader('Content-Type', 'application/javascript')
          const transformed = await server.transformRequest(
            '/@fs/' + path.resolve(pageDir, 'src/serviceWorker.ts'),
          )
          res.end(transformed?.code ?? sw)
          return
        }

        if (req.url !== '/' || !req.headers.accept?.includes('text/html')) return next()

        try {
          const request = (await import('../server/Request.js')).fromNodeListener(req, res)
          const credential = Credential.fromRequest(request)
          if (Challenge.verify(credential.challenge, { secretKey })) {
            res.setHeader('Content-Type', 'text/html')
            res.end(
              '<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><style>html{color-scheme:light dark}</style></head><body><h1>Payment verified!</h1><p>This is the protected content.</p></body></html>',
            )
            return
          }
        } catch {}

        const challenge = Challenge.fromMethod(options.method, {
          secretKey,
          realm: 'localhost',
          request: options.request,
          expires: Expires.minutes(5),
        })

        const dataJson = JSON.stringify({ challenge, config: options.config ?? {} })
        const page = await fs.readFile(path.resolve(pageDir, 'src/page.html'), 'utf-8')
        let methodContent = ''
        try {
          methodContent = (
            await fs.readFile(path.resolve(server.config.root, `src/${intent}.html`), 'utf-8')
          ).trimEnd()
        } catch {}

        const html = page
          .replace('<!--mppx:head-->', defaultHead)
          .replace(
            '<!--mppx:data-->',
            `<script id="${dataElementId}" type="application/json">${dataJson}</script>`,
          )
          .replace(
            '<!--mppx:script-->',
            `<script type="module" src="/@fs/${path.resolve(pageDir, 'src/page.ts')}"></script>`,
          )
          .replace(
            '<!--mppx:method-->',
            `${methodContent}\n  <script type="module" src="/src/${intent}.ts"></script>`,
          )

        const transformed = await server.transformIndexHtml(req.url, html)
        res.setHeader('Content-Type', 'text/html; charset=utf-8')
        res.setHeader('WWW-Authenticate', Challenge.serialize(challenge))
        res.setHeader('Cache-Control', 'no-store')
        res.statusCode = 402
        res.end(transformed)
      })
    },
  }
}

export function build(names: string | string[]): Plugin {
  const items = Array.isArray(names) ? names : [names]
  let root: string
  return {
    name: 'mppx:emit',
    apply: 'build',
    config: () => ({
      build: {
        outDir: 'dist',
        emptyOutDir: true,
        rolldownOptions: {
          input: Object.fromEntries(items.map((name) => [name, `src/${name}.ts`])),
          output: { entryFileNames: '[name].js', format: 'es' as const },
          // Not yet in Vite's types but supported by Rolldown
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
      // e.g. root = src/html/tempo → method = tempo
      const method = path.basename(root)
      const output = path.resolve(root, `../../${method}/server/internal/html.gen.ts`)

      // Read shared chunks (if code splitting produced any)
      const assetsDir = path.resolve(root, 'dist/assets')
      const chunks: string[] = []
      try {
        for (const file of await fs.readdir(assetsDir)) {
          if (file.endsWith('.js'))
            chunks.push((await fs.readFile(path.resolve(assetsDir, file), 'utf-8')).trim())
        }
      } catch {}

      for (const name of items) {
        let content = ''
        try {
          content = (await fs.readFile(path.resolve(root, `src/${name}.html`), 'utf-8')).trimEnd()
        } catch {}
        const entryScript = (
          await fs.readFile(path.resolve(root, `dist/${name}.js`), 'utf-8')
        ).trim()
        // Strip chunk imports — their contents are inlined below
        const cleanedEntry = entryScript.replace(/^import\s.*?;\n?/gm, '')
        const allScripts = [...chunks, cleanedEntry].join('\n')
        const code = escapeTemplateLiteral(allScripts)
        const scriptBlock = `\n  <script type="module">\n${indent(code, 4)}\n  </script>`

        const body = [`export const html =`, `  \`\n${content}${scriptBlock}\n  \``].join('\n')
        const file = [comment(body), ``, body].join('\n')

        await fs.mkdir(path.dirname(output), { recursive: true })
        await fs.writeFile(output, file + '\n')
        console.log(`  Wrote ${output}`)
      }
    },
  }
}

export function buildPage(): Plugin {
  let root: string
  return {
    name: 'mppx:page_emit',
    apply: 'build',
    config: () => ({
      build: {
        outDir: 'dist',
        emptyOutDir: true,
        rolldownOptions: {
          input: 'src/page.ts',
          output: { entryFileNames: '[name].js', format: 'es' as const },
        },
        modulePreload: false,
        minify: true,
      },
    }),
    configResolved(config) {
      root = config.root
    },
    async closeBundle() {
      const output = path.resolve(root, '../../server/internal/html.gen.ts')
      // Build service worker separately (different global scope)
      const { build } = await import('vite')
      await build({
        root,
        logLevel: 'warn',
        configFile: false,
        build: {
          outDir: 'dist',
          emptyOutDir: false,
          rolldownOptions: {
            input: path.resolve(root, 'src/serviceWorker.ts'),
            output: { entryFileNames: 'serviceWorker.js', format: 'es' },
          },
          minify: true,
          modulePreload: false,
        },
      })

      const pageContent = (
        await fs.readFile(path.resolve(root, 'src/page.html'), 'utf-8')
      ).trimEnd()
      const pageBundledScript = escapeTemplateLiteral(
        (await fs.readFile(path.resolve(root, 'dist/page.js'), 'utf-8')).trim(),
      )
      const pageScript = `\n  <script type="module">\n${indent(pageBundledScript, 4)}\n  </script>`
      const serviceWorkerScript = (
        await fs.readFile(path.resolve(root, 'dist/serviceWorker.js'), 'utf-8')
      ).trim()

      const body = [
        `export const content = \`\n${pageContent}\``,
        ``,
        `export const script = \`${pageScript}\n  \``,
        ``,
        `export const serviceWorker = ${JSON.stringify(serviceWorkerScript)}`,
      ].join('\n')
      const file = [comment(body), ``, body].join('\n')

      await fs.mkdir(path.dirname(output), { recursive: true })
      await fs.writeFile(output, file + '\n')
      console.log(`  Wrote ${output}`)
    },
  }
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
