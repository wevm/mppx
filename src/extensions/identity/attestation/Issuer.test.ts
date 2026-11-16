import * as Attestation from 'mppx/extensions/identity/attestation'
import { describe, expect, test } from 'vp/test'
import { jwkThumbprint, keyPair, remoteSigner } from '~test/Identity.js'

const issuer = 'https://issuer.example'
const audience = 'https://api.example'

describe('Issuer.create', () => {
  test('signs an attestation that the server verifier accepts, with uid and cnf', async () => {
    const keys = await keyPair()
    const attester = Attestation.Issuer.create({ issuer: `${issuer}/`, signingKey: keys })
    const token = await attester.sign({
      audience: `${audience}/`,
      cnf: { addr: '0x1111111111111111111111111111111111111111' },
      sub: '583231',
      type: 'github',
      uid: 'user_1',
    })
    const decoded = Attestation.decode(token)!
    expect(decoded.header).toEqual({
      alg: 'EdDSA',
      kid: await jwkThumbprint(keys.publicKey),
      typ: 'mpp-attestation+jwt',
    })
    expect(decoded.claims).toMatchObject({
      aud: audience,
      cnf: { addr: '0x1111111111111111111111111111111111111111' },
      iss: issuer,
      sub: '583231',
      type: 'github',
      uid: 'user_1',
    })
    expect(decoded.claims.exp! - decoded.claims.iat!).toBe(3_600)

    const result = await Attestation.verify(token, {
      audience,
      issuer,
      keyResolver: attester.keyResolver,
      type: 'github',
    })
    expect(result.status).toBe('valid')
    if (result.status === 'valid') expect(result.claims.uid).toBe('user_1')
  })

  test('verifies through its published key set', async () => {
    const attester = Attestation.Issuer.create({ issuer, signingKey: await keyPair() })
    const token = await attester.sign({ audience, sub: 'ada@example.com', type: 'email' })
    const fetch = (async (input: RequestInfo | URL) =>
      (await attester.handle(new Request(input)))!) as typeof globalThis.fetch
    const verifier = Attestation.Server.verifier({ audience, fetch, issuer, type: 'email' })
    const verified = await verifier.verify(
      new Request(`${audience}/resource`, { headers: { [Attestation.Constants.header]: token } }),
    )
    expect(verified.status).toBe('valid')
    const jwks = await attester.handle(new Request(`${issuer}/.well-known/jwks.json`))
    expect(jwks?.headers.get('Access-Control-Allow-Origin')).toBe('*')
    expect(await attester.handle(new Request(`${issuer}/other`))).toBeUndefined()
  })

  test('signs with a remote signer', async () => {
    const keys = await keyPair()
    const calls: Uint8Array[] = []
    const attester = Attestation.Issuer.create({
      issuer,
      signingKey: remoteSigner(keys, { calls }),
    })
    const token = await attester.sign({ audience, sub: 'ada@example.com', type: 'email' })
    expect(calls).toHaveLength(1)
    const result = await Attestation.verify(token, {
      audience,
      issuer,
      keyResolver: attester.keyResolver,
      type: 'email',
    })
    expect(result.status).toBe('valid')
  })

  test('registered claims win over extra claims', async () => {
    const attester = Attestation.Issuer.create({ issuer, signingKey: await keyPair() })
    const token = await attester.sign({
      audience,
      claims: { iss: 'https://evil.example', level: 2, sub: 'other' },
      sub: 'ada@example.com',
      type: 'email',
    })
    expect(Attestation.decode(token)!.claims).toMatchObject({
      iss: issuer,
      level: 2,
      sub: 'ada@example.com',
    })
  })

  test('rejects bad parameters', async () => {
    const signingKey = await keyPair()
    expect(() =>
      Attestation.Issuer.create({ issuer: 'http://issuer.example', signingKey }),
    ).toThrow('https URL')
    expect(() => Attestation.Issuer.create({ issuer, signingKey, ttl: 0 })).toThrow('ttl')
    const attester = Attestation.Issuer.create({ issuer, signingKey })
    await expect(attester.sign({ audience: 'ftp://x', sub: 'a', type: 'email' })).rejects.toThrow(
      'audience',
    )
    await expect(attester.sign({ audience, sub: 'a', type: 'two words' })).rejects.toThrow('token')
    await expect(attester.sign({ audience, sub: '', type: 'email' })).rejects.toThrow('subject')
    for (const ttl of [0, -1, 1.5, Number.POSITIVE_INFINITY, 1e12])
      await expect(attester.sign({ audience, sub: 'a', type: 'email', ttl })).rejects.toThrow('ttl')
    await expect(attester.sign({ audience, sub: 'a', type: 'email', uid: '' })).rejects.toThrow(
      'uid',
    )
    await expect(
      attester.sign({ audience, sub: 'a', type: 'email', cnf: { jkt: 1 } as never }),
    ).rejects.toThrow('cnf')
    await expect(
      attester.sign({ audience, sub: 'a', type: 'email', claims: { pad: 'x'.repeat(9_000) } }),
    ).rejects.toThrow('longer')
    for (const claims of [{ uid: 5 }, { cnf: { addr: 1 } }])
      await expect(attester.sign({ audience, sub: 'a', type: 'email', claims })).rejects.toThrow()
    const circular: Record<string, unknown> = {}
    circular.self = circular
    for (const claims of [
      { big: 1n },
      circular,
      { toJSON: () => ({ sub: 'other' }) },
      { cnf: { toJSON: () => ({}) } },
    ])
      await expect(
        attester.sign({ audience, sub: 'a', type: 'email', claims }),
      ).rejects.toBeInstanceOf(Attestation.Issuer.InvalidParametersError)
  })
})

describe('verify', () => {
  test('rejects malformed uid and cnf', async () => {
    const keys = await keyPair()
    const keyId = await jwkThumbprint(keys.publicKey)
    const now = Math.floor(Date.now() / 1_000)
    const base = { aud: audience, exp: now + 60, iat: now, iss: issuer, sub: 's', type: 'email' }
    const keyResolver = () => keys.publicKey
    for (const [extra, reason] of [
      [{ uid: 1 }, 'user ID'],
      [{ uid: '' }, 'user ID'],
      [{ cnf: 'x' }, 'confirmation'],
      [{ cnf: { jkt: 123 } }, 'confirmation'],
      [{ cnf: { addr: ['0x1'] } }, 'confirmation'],
    ] as const) {
      const token = await Attestation.sign({ ...base, ...extra } as never, { key: keys, keyId })
      const result = await Attestation.verify(token, {
        audience,
        issuer,
        keyResolver,
        type: 'email',
      })
      expect(result).toEqual({ status: 'invalid', reason: expect.stringContaining(reason) })
    }
  })
})
