import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import { build } from 'vite'
import { afterEach, describe, expect, test } from 'vp/test'

import * as Method from '../../Method.js'
import * as z from '../../zod.js'
import mppx from '../vite.js'

const method = Method.from({
  intent: 'charge',
  name: 'test',
  schema: {
    credential: { payload: z.object({ ok: z.boolean() }) },
    request: z.object({ amount: z.string() }),
  },
})

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { force: true, recursive: true })))
})

describe('mppx/html/vite', () => {
  test('build: supports html-only method pages', async () => {
    const root = await createFixture({
      'src/charge.html': '<div class="html-only">HTML only payment page</div>',
    })

    await build({
      configFile: false,
      logLevel: 'silent',
      plugins: [mppx({ method, output: './html.gen.ts' })],
      root,
    })

    const output = await fs.readFile(path.join(root, 'html.gen.ts'), 'utf8')
    expect(output).toContain('HTML only payment page')
    expect(output).not.toContain('<script type="module">')
  })

  test('build: inlines imported css into html.gen.ts', async () => {
    const root = await createFixture({
      'src/charge.ts': "import './charge.css'\ndocument.documentElement.dataset.ready = '1'\n",
      'src/charge.css': '.html-css-test{color:red}',
    })

    await build({
      configFile: false,
      logLevel: 'silent',
      plugins: [mppx({ method, output: './html.gen.ts' })],
      root,
    })

    const output = await fs.readFile(path.join(root, 'html.gen.ts'), 'utf8')
    expect(output).toContain('<style>')
    expect(output).toContain('.html-css-test')
    expect(output).toContain('color:red')
  })

  test('build: supports custom entry basenames', async () => {
    const root = await createFixture({
      'src/form.html': '<div class="form-only">Form payment page</div>',
      'src/form.ts': "import './form.css'\ndocument.documentElement.dataset.formReady = '1'\n",
      'src/form.css': '.form-css-test{color:blue}',
    })

    await build({
      configFile: false,
      logLevel: 'silent',
      plugins: [mppx({ method, entry: 'form', output: './html.gen.ts' })],
      root,
    })

    const output = await fs.readFile(path.join(root, 'html.gen.ts'), 'utf8')
    expect(output).toContain('Form payment page')
    expect(output).toContain('.form-css-test')
    expect(output).toMatch(/color:(blue|#00f)/)
  })
})

async function createFixture(files: Record<string, string>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mppx-html-vite-'))
  dirs.push(root)

  for (const [file, contents] of Object.entries(files)) {
    const target = path.join(root, file)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, contents)
  }

  return root
}
