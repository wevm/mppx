import fs from 'node:fs'
import { builtinModules } from 'node:module'
import path from 'node:path'

import { build } from 'rolldown'

const root = path.resolve(import.meta.dirname, '..')
const packageJson = JSON.parse(fs.readFileSync(path.resolve(root, 'package.json'), 'utf8'))
const externalPackages = [
  '@stripe/stripe-js',
  'eventsource-parser',
  'ox',
  'structured-headers',
  'viem',
  'zod',
]
const builtins = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)])
const bundledModuleIds = new Set<string>()

function external(id: string) {
  if (builtins.has(id)) return true
  return externalPackages.some((name) => id === name || id.startsWith(`${name}/`))
}

async function bundle(input: string, file: string) {
  const result = await build({
    input: path.resolve(root, input),
    external,
    plugins: [
      {
        name: 'bundle-incur-stdio',
        transform(code, id) {
          if (!id.includes('/incur/') || !id.endsWith('/Mcp.js')) return
          return code.replace(
            /importModule\((['"])@modelcontextprotocol\/server\/stdio\1\)/g,
            "import('@modelcontextprotocol/server')",
          )
        },
      },
    ],
    transform: {
      define: {
        __MPPX_CLI_VERSION__: JSON.stringify(packageJson.version),
      },
    },
    output: {
      codeSplitting: false,
      comments: { legal: true },
      file: path.resolve(root, file),
      format: 'esm',
      minify: true,
      sourcemap: false,
    },
  })

  for (const output of result.output)
    if (output.type === 'chunk')
      for (const moduleId of output.moduleIds) bundledModuleIds.add(moduleId)

  fs.rmSync(path.resolve(root, `${file}.map`), { force: true })
  const code = fs.readFileSync(path.resolve(root, file), 'utf8')
  if (/from\s*['"]incur['"]|import\(['"]incur['"]\)/.test(code))
    throw new Error(`${file} still contains an incur import`)
}

/** Resolve the owning package directory for a bundled node_modules file. */
function packageDirectory(moduleId: string) {
  const marker = `${path.sep}node_modules${path.sep}`
  const markerIndex = moduleId.lastIndexOf(marker)
  if (markerIndex === -1) return

  const packagePath = moduleId.slice(markerIndex + marker.length).split(path.sep)
  const segmentCount = packagePath[0]?.startsWith('@') ? 2 : 1
  return path.join(
    moduleId.slice(0, markerIndex + marker.length),
    ...packagePath.slice(0, segmentCount),
  )
}

/** Write licenses for packages whose code was included in the CLI bundles. */
function writeThirdPartyLicenses() {
  const packageDirectories = new Set(
    [...bundledModuleIds].map(packageDirectory).filter((value) => value !== undefined),
  )
  const notices = [...packageDirectories]
    .map((directory) => {
      const manifest = JSON.parse(
        fs.readFileSync(path.join(directory, 'package.json'), 'utf8'),
      ) as {
        license?: string
        name: string
        version: string
      }
      const licenseFiles = fs
        .readdirSync(directory)
        .filter((file) => /^(copying|licen[cs]e|notice)(\..*)?$/i.test(file))
        .sort()

      return {
        heading: `${manifest.name}@${manifest.version} (${manifest.license ?? 'license unspecified'})`,
        licenses: licenseFiles.map((file) => ({
          file,
          text: fs.readFileSync(path.join(directory, file), 'utf8').trim(),
        })),
      }
    })
    .sort((a, b) => a.heading.localeCompare(b.heading))

  const content = notices
    .map(({ heading, licenses }) => {
      const sections = licenses.map(
        ({ file, text }) => `${file}\n${'-'.repeat(file.length)}\n${text}`,
      )
      return [`# ${heading}`, ...sections].join('\n\n')
    })
    .join('\n\n---\n\n')

  fs.writeFileSync(path.resolve(root, 'dist/cli/THIRD-PARTY-LICENSES.txt'), `${content}\n`)
}

await bundle('src/cli/cli.ts', 'dist/cli/cli.js')
await bundle('src/cli/plugins/index.ts', 'dist/cli/plugins/index.js')
writeThirdPartyLicenses()

const binFile = path.resolve(root, 'dist/bin.js')
fs.writeFileSync(
  binFile,
  "#!/usr/bin/env node\nimport cli from './cli/cli.js'\n\nawait cli.serve()\n",
)
fs.chmodSync(binFile, 0o755)

console.log('bundled dist/bin.js and dist/cli/plugins/index.js')
