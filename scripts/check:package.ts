import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'mppx-package-'))
const limits = {
  fileCount: 460,
  packedBytes: 1_200_000,
  unpackedBytes: 4_750_000,
}

/** Run a package validation command and fail with its exit status. */
function run(command: string, args: string[], capture = false) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}`)
  return result.stdout
}

/** Collect relative file targets from a package manifest field. */
function packageTargets(value: unknown): string[] {
  if (typeof value === 'string') return value.startsWith('./') ? [value.slice(2)] : []
  if (!value || typeof value !== 'object') return []
  return Object.values(value).flatMap(packageTargets)
}

try {
  run(process.execPath, ['--import', 'tsx', 'scripts/build:html.ts'])
  run('pnpm', ['exec', 'zile', 'publish:prepare'])
  run(process.execPath, ['--import', 'tsx', 'scripts/build:cli.ts'])
  run(process.execPath, ['--import', 'tsx', 'scripts/prepare:publish.ts'])

  const pack = JSON.parse(
    run('pnpm', ['pack', '--pack-destination', temporaryDirectory, '--json'], true),
  ) as {
    filename: string
    files: { path: string }[]
  }
  const paths = pack.files.map((file) => file.path)
  const allowedRootFiles = new Set(['CHANGELOG.md', 'LICENSE', 'README.md', 'package.json'])
  const unexpected = paths.filter(
    (file) => !file.startsWith('dist/') && !allowedRootFiles.has(file),
  )
  if (unexpected.length > 0)
    throw new Error(
      `Unexpected package files:\n${unexpected.map((file) => `- ${file}`).join('\n')}`,
    )

  const forbidden = paths.filter(
    (file) =>
      file.startsWith('src/') ||
      file.includes('/node_modules/') ||
      /(?:^|\/)node_modules\//.test(file) ||
      /\.map$/.test(file) ||
      /(?:^|\/)__tests__(?:\/|$)/.test(file) ||
      /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file),
  )
  if (forbidden.length > 0)
    throw new Error(`Forbidden package files:\n${forbidden.map((file) => `- ${file}`).join('\n')}`)

  const extractDirectory = path.join(temporaryDirectory, 'extract')
  fs.mkdirSync(extractDirectory)
  run('tar', ['-xzf', pack.filename, '-C', extractDirectory])
  const manifest = JSON.parse(
    fs.readFileSync(path.join(extractDirectory, 'package/package.json'), 'utf8'),
  ) as {
    bin?: Record<string, string>
    dependencies?: Record<string, string>
    exports?: Record<string, unknown>
    main?: string
    module?: string
    types?: string
  }
  if (manifest.bin?.mppx !== './dist/bin.js')
    throw new Error(`Expected the mppx binary to target dist/bin.js, got ${manifest.bin?.mppx}`)
  if (manifest.bin?.['mppx.src']) throw new Error('Published manifest includes mppx.src')
  if (manifest.dependencies?.incur) throw new Error('Published manifest includes incur')
  if (JSON.stringify(manifest.exports).includes('"src"'))
    throw new Error('Published exports include a src condition')

  const packageRoot = path.join(extractDirectory, 'package')
  const missingTargets = packageTargets({
    bin: manifest.bin,
    exports: manifest.exports,
    main: manifest.main,
    module: manifest.module,
    types: manifest.types,
  }).filter((target) => !fs.existsSync(path.join(packageRoot, target)))
  if (missingTargets.length > 0)
    throw new Error(
      `Published manifest targets missing files:\n${missingTargets.map((file) => `- ${file}`).join('\n')}`,
    )

  const packedBytes = fs.statSync(pack.filename).size
  const unpackedBytes = pack.files.reduce(
    (total, file) => total + fs.statSync(path.join(root, file.path)).size,
    0,
  )
  const metrics = { fileCount: paths.length, packedBytes, unpackedBytes }

  for (const [metric, value] of Object.entries(metrics)) {
    const limit = limits[metric as keyof typeof limits]
    if (value > limit)
      throw new Error(`${metric} ${value.toLocaleString()} exceeds ${limit.toLocaleString()}`)
  }

  console.log(
    `package: ${metrics.fileCount} files, ${metrics.packedBytes.toLocaleString()} B packed, ${metrics.unpackedBytes.toLocaleString()} B unpacked`,
  )
} finally {
  if (fs.existsSync(path.join(root, 'package.tmp.json')))
    run('pnpm', ['exec', 'zile', 'publish:post'])
  fs.rmSync(temporaryDirectory, { force: true, recursive: true })
}
