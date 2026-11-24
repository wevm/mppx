/**
 * Tempo ID identity end to end on a Tempo localnet: a real HTTP server charges with the tempo
 * method, and a client pays from the account its DPoP-bound Tempo ID token grants.
 */
import { Receipt, Store } from 'mppx'
import { Mppx, tempo } from 'mppx/client'
import * as TempoId from 'mppx/extensions/identity/tempo'
import { Mppx as Mppx_server, tempo as tempo_server } from 'mppx/server'
import { Base64 } from 'ox'
import { Actions } from 'viem/tempo'
import { afterAll, beforeAll, expect, test } from 'vp/test'
import * as Http from '~test/Http.js'
import { accounts, asset, client } from '~test/tempo/viem.js'

const issuer = 'https://id.tempo.xyz'
const clientId = 'app_localnet'
const payer = accounts[2]
const recipient = accounts[0].address
const encode = (value: unknown) =>
  Base64.fromString(JSON.stringify(value), { pad: false, url: true })

let keyPair: CryptoKeyPair
let jwk: JsonWebKey
let httpServer: Http.TestServer

/** Signs a JWS with the stand-in issuer's RS256 key. */
async function sign(header: Record<string, unknown>, claims: Record<string, unknown>) {
  const input = `${encode({ alg: 'RS256', kid: 'k1', ...header })}.${encode(claims)}`
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    keyPair.privateKey,
    new TextEncoder().encode(input),
  )
  return `${input}.${Base64.fromBytes(new Uint8Array(signature), { pad: false, url: true })}`
}

/** An access token shaped like Tempo ID's, bound to `dpop` and granting `account`. */
async function accessToken(dpop: TempoId.DpopKey, account: string) {
  const { crv, kty, x, y } = dpop.jwk
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify({ crv, kty, x, y })),
  )
  const now = Math.floor(Date.now() / 1000)
  return sign(
    { typ: 'at+jwt' },
    {
      access_keys: [{ account, address: account, chain_id: client.chain.id }],
      aud: issuer,
      client_id: clientId,
      cnf: { jkt: Base64.fromBytes(new Uint8Array(digest), { pad: false, url: true }) },
      compliance: { [account]: 'clear' },
      exp: now + 300,
      iat: now,
      iss: issuer,
      sub: 'user_localnet',
    },
  )
}

async function createDpop(): Promise<TempoId.DpopKey> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair
  const key = await crypto.subtle.exportKey('jwk', pair.publicKey)
  return {
    jwk: { crv: key.crv!, kty: key.kty!, x: key.x!, y: key.y! },
    privateKey: pair.privateKey,
  }
}

async function balance() {
  return (await Actions.token.getBalance(client, { account: payer.address, token: asset })).amount
}

beforeAll(async () => {
  keyPair = (await crypto.subtle.generateKey(
    {
      hash: 'SHA-256',
      modulusLength: 2048,
      name: 'RSASSA-PKCS1-v1_5',
      publicExponent: new Uint8Array([1, 0, 1]),
    },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair
  jwk = {
    ...(await crypto.subtle.exportKey('jwk', keyPair.publicKey)),
    alg: 'RS256',
    kid: 'k1',
  } as JsonWebKey
  const tempoId = TempoId.Server.create({
    chainId: client.chain.id,
    clientId,
    fetch: (async () => Response.json({ keys: [jwk] })) as typeof globalThis.fetch,
    store: Store.memory(),
  })
  const server = Mppx_server.create({
    methods: [
      tempo_server.charge({
        chainId: client.chain.id,
        currency: asset,
        getClient: () => client,
        recipient,
      }),
    ],
    requiresAuth: true,
    secretKey: 'localnet-secret-key-localnet-secret!',
  })
  httpServer = await Http.createServer(async (req, res) => {
    const result = await Mppx_server.toNodeListener(
      server.charge({
        amount: '1',
        identity: { payment: tempoId.paymentCheck, request: [tempoId.verifier] },
      }),
    )(req, res)
    if (result.status !== 200) return
    res.end('fortune')
  })
})

afterAll(() => httpServer?.close())

test("pays from the account the user's DPoP-bound token grants", async () => {
  const dpop = await createDpop()
  const token = await accessToken(dpop, payer.address)
  const mppx = Mppx.create({
    identity: [TempoId.Client.prover({ accessToken: () => token, dpop, scope: [httpServer.url] })],
    methods: [tempo({ account: payer, getClient: () => client })],
    polyfill: false,
  })
  const before = await balance()

  const response = await mppx.fetch(httpServer.url)

  expect(response.status).toBe(200)
  expect(await response.text()).toBe('fortune')
  expect(Receipt.fromResponse(response).status).toBe('success')
  expect(await balance()).toBeLessThan(before)
})

test('refuses a payment from an account the token does not grant, before it settles', async () => {
  const dpop = await createDpop()
  const token = await accessToken(dpop, accounts[3].address)
  const mppx = Mppx.create({
    identity: [TempoId.Client.prover({ accessToken: () => token, dpop, scope: [httpServer.url] })],
    methods: [tempo({ account: payer, getClient: () => client })],
    polyfill: false,
  })
  const before = await balance()

  const response = await mppx.fetch(httpServer.url)

  expect(response.status).toBe(403)
  expect(await balance()).toBe(before)
})

test('challenges a request without a token', async () => {
  const response = await fetch(httpServer.url)

  expect(response.status).toBe(401)
})
