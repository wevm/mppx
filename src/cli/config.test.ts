import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { defineConfig } from './config.js'
import { loadConfig } from './internal.js'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mppx-config-test-'))
  vi.stubEnv('MPPX_CONFIG', '')
})

afterEach(() => {
  vi.unstubAllEnvs()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('defineConfig', () => {
  test('returns the config object as-is', () => {
    const config = defineConfig({ methods: [] })
    expect(config).toEqual({ methods: [] })
  })
})

describe('loadConfig', () => {
  test('returns undefined when no config file exists', async () => {
    vi.spyOn(process, 'cwd').mockReturnValue(tmpDir)
    const config = await loadConfig()
    expect(config).toBeUndefined()
    vi.mocked(process.cwd).mockRestore()
  })

  test('loads config from MPPX_CONFIG env var', async () => {
    const configPath = path.join(tmpDir, 'custom.mjs')
    fs.writeFileSync(configPath, 'export default { methods: [] }')
    vi.stubEnv('MPPX_CONFIG', configPath)
    const result = await loadConfig()
    expect(result?.config).toEqual({ methods: [] })
    expect(result?.path).toBe(configPath)
  })

  test('returns undefined when MPPX_CONFIG points to nonexistent file', async () => {
    vi.stubEnv('MPPX_CONFIG', path.join(tmpDir, 'nonexistent.ts'))
    const config = await loadConfig()
    expect(config).toBeUndefined()
  })

  test('loads mppx.config.mjs from cwd', async () => {
    const configPath = path.join(tmpDir, 'mppx.config.mjs')
    fs.writeFileSync(configPath, 'export default { methods: [] }')
    vi.spyOn(process, 'cwd').mockReturnValue(tmpDir)
    const result = await loadConfig()
    expect(result?.config).toEqual({ methods: [] })
    expect(result?.path).toBe(configPath)
    vi.mocked(process.cwd).mockRestore()
  })

  test('walks up from cwd to find config', async () => {
    const nested = path.join(tmpDir, 'a', 'b', 'c')
    fs.mkdirSync(nested, { recursive: true })
    const configPath = path.join(tmpDir, 'mppx.config.mjs')
    fs.writeFileSync(configPath, 'export default { methods: [] }')
    vi.spyOn(process, 'cwd').mockReturnValue(nested)
    const result = await loadConfig()
    expect(result?.config).toEqual({ methods: [] })
    expect(result?.path).toBe(configPath)
    vi.mocked(process.cwd).mockRestore()
  })

  test('MPPX_CONFIG takes priority over cwd config', async () => {
    fs.writeFileSync(path.join(tmpDir, 'mppx.config.mjs'), 'export default { methods: ["cwd"] }')
    const envConfig = path.join(tmpDir, 'env.mjs')
    fs.writeFileSync(envConfig, 'export default { methods: ["env"] }')
    vi.stubEnv('MPPX_CONFIG', envConfig)
    vi.spyOn(process, 'cwd').mockReturnValue(tmpDir)
    const result = await loadConfig()
    expect(result?.config).toEqual({ methods: ['env'] })
    expect(result?.path).toBe(envConfig)
    vi.mocked(process.cwd).mockRestore()
  })


})
