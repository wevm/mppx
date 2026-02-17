import { Mppx, tempo } from './src/client/index.js'
import { privateKeyToAccount } from 'viem/accounts'
import { createClient, http } from 'viem'
import { tempoModerato } from 'viem/chains'
import { execSync } from 'node:child_process'

let key: string
try {
  key = execSync('security find-generic-password -s mppx -w 2>/dev/null', { encoding: 'utf8' }).trim()
} catch {
  console.error('No key in keychain')
  process.exit(1)
}

const account = privateKeyToAccount(key as `0x${string}`)
const client = createClient({ chain: tempoModerato, transport: http() })

const mppx = Mppx.create({
  methods: tempo({ account, getClient: () => client }),
  polyfill: false,
})

const url = 'https://mpp.tempo.xyz/api/ping/paid'
console.log('> GET', url)

const res1 = await fetch(url)
console.log('< Status:', res1.status)

if (res1.status !== 402) {
  console.log(await res1.text())
  process.exit(0)
}

console.log('< WWW-Authenticate:', res1.headers.get('www-authenticate')?.slice(0, 120), '...')

const credential = await mppx.createCredential(res1)
console.log('> Sending credential...')

const res2 = await fetch(url, {
  headers: { Authorization: credential },
})
console.log('< Status:', res2.status)
const body = await res2.text()
console.log('< Body:', body)
if (res2.headers.get('payment-receipt')) {
  console.log('< Payment-Receipt:', res2.headers.get('payment-receipt')?.slice(0, 80), '...')
}
