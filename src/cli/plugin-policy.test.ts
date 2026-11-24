import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import * as Http from '~test/Http.js'

import * as Challenge from '../Challenge.js'
import cli from './cli.js'
import { runPersistentSessionRequest } from './sessions/request.js'

vi.mock('./sessions/request.js', () => ({
  runPersistentSessionRequest: vi.fn(async () => {
    throw new Error('Policy bypass')
  }),
}))

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

test.each(['private-key', 'keychain'])(
  'configured plugin rejects payment before persistent %s signing',
  async (account) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mppx-plugin-policy-'))
    const config = path.join(dir, 'mppx.config.mjs')
    fs.writeFileSync(
      config,
      `export default { plugins: [{ method: 'tempo', async setup() {
    return { tokenSymbol: 'USD', tokenDecimals: 6, methods: [],
      async createCredential() { throw new Error('Plugin rejected recipient') } }
  } }] }`,
    )
    vi.stubEnv('MPPX_PRIVATE_KEY', account === 'private-key' ? `0x${'01'.repeat(32)}` : '')
    vi.stubEnv('XDG_CONFIG_HOME', dir)
    vi.stubEnv('XDG_DATA_HOME', dir)
    vi.stubEnv('XDG_STATE_HOME', dir)
    const challenge = Challenge.from({
      id: 'policy-test',
      realm: 'localhost',
      method: 'tempo',
      intent: 'session',
      request: {
        amount: '100',
        currency: `0x${'20'.repeat(20)}`,
        recipient: `0x${'12'.repeat(20)}`,
        unitType: 'request',
        methodDetails: { chainId: 42431 },
      },
    })
    let paid = 0
    const server = await Http.createServer((req, res) => {
      if (req.headers.authorization) paid++
      res.writeHead(402, { 'WWW-Authenticate': Challenge.serialize(challenge) })
      res.end()
    })
    let output = ''
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      output += String(chunk)
      return true
    })
    try {
      await cli.serve([server.url, '-s', '--config', config], {
        stdout(s) {
          output += s
        },
        exit() {},
      })
      expect(output).toContain('Plugin rejected recipient')
      expect(runPersistentSessionRequest).not.toHaveBeenCalled()
      expect(paid).toBe(0)
    } finally {
      server.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  },
)
