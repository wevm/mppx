import { P256, Secp256k1 } from 'ox'
import { KeyAuthorization, SignatureEnvelope, TxEnvelopeTempo } from 'ox/tempo'
import type { Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { Transaction } from 'viem/tempo'
import { beforeAll, describe, expect, test } from 'vp/test'

import * as Store from '../../../Store.js'
import type { SessionCredentialPayload } from '../precompile/Protocol.js'
import * as SponsorshipLimit from './SponsorshipLimit.js'

const payerKey = `0x${'ab'.repeat(32)}` as const
const payer = privateKeyToAccount(payerKey)
const accessKeyPrivateKey = `0x${'cd'.repeat(32)}` as const
const accessKey = privateKeyToAccount(accessKeyPrivateKey)
const victim = '0xa5cc3c03994db5b0d9ba5e4f6d2efbd9f213b141'
let openTransaction: Hex

beforeAll(async () => {
  openTransaction = (await payer.signTransaction(
    {
      chainId: 4217,
      calls: [{ to: '0x0000000000000000000000000000000000000001', data: '0x' }],
      nonce: 0,
      gas: 100_000n,
      maxFeePerGas: 1n,
      maxPriorityFeePerGas: 1n,
    } as never,
    { serializer: Transaction.serialize as never },
  )) as Hex
})

function unsignedOpen(extra: Partial<TxEnvelopeTempo.TxEnvelopeTempo> = {}) {
  const {
    from: _sender,
    signature: _signature,
    ...fields
  } = TxEnvelopeTempo.deserialize(openTransaction as TxEnvelopeTempo.Serialized)
  return TxEnvelopeTempo.from({ ...fields, ...extra })
}

function withSignature(
  envelope: TxEnvelopeTempo.TxEnvelopeTempo,
  signature: SignatureEnvelope.SignatureEnvelope,
) {
  return TxEnvelopeTempo.serialize(TxEnvelopeTempo.from({ ...envelope, signature }))
}

function keychainSignature(envelope: TxEnvelopeTempo.TxEnvelopeTempo) {
  return SignatureEnvelope.from({
    type: 'keychain',
    userAddress: victim,
    version: 'v1',
    inner: SignatureEnvelope.from(
      Secp256k1.sign({
        payload: TxEnvelopeTempo.getSignPayload(envelope),
        privateKey: accessKeyPrivateKey,
      }),
    ),
  })
}

function openPayload(transaction: Hex = openTransaction): SessionCredentialPayload {
  return {
    action: 'open',
    channelId: `0x${'11'.repeat(32)}`,
    cumulativeAmount: '1',
    descriptor: {
      authorizedSigner: payer.address,
      expiringNonceHash: `0x${'22'.repeat(32)}`,
      operator: '0x0000000000000000000000000000000000000000',
      payee: '0x0000000000000000000000000000000000000002',
      payer: victim,
      salt: `0x${'33'.repeat(32)}`,
      token: '0x0000000000000000000000000000000000000003',
    },
    signature: '0x1234',
    transaction,
    type: 'transaction',
  }
}

describe('SponsorshipLimit.verifiedPayer', () => {
  test('keys on the recovered transaction signer', () => {
    expect(SponsorshipLimit.verifiedPayer(openTransaction)).toBe(payer.address.toLowerCase())
  })

  test('ignores a victim address placed in the 0x78 explicit sender slot', () => {
    const envelope = unsignedOpen({ feePayerSignature: null })
    const signature = Secp256k1.sign({
      payload: TxEnvelopeTempo.getSignPayload(envelope),
      privateKey: payerKey,
    })
    const spoofed = TxEnvelopeTempo.serialize(
      TxEnvelopeTempo.from({ ...envelope, signature: SignatureEnvelope.from(signature) }),
      { format: 'feePayer', sender: victim },
    )
    expect(spoofed.startsWith('0x78')).toBe(true)
    expect(TxEnvelopeTempo.deserialize(spoofed as TxEnvelopeTempo.Serialized).from).toBe(victim)
    expect(SponsorshipLimit.verifiedPayer(spoofed)).toBe(payer.address.toLowerCase())
  })

  test('keys a passkey transaction on its verified signer and refuses a forged one', () => {
    const privateKey = P256.randomPrivateKey()
    const publicKey = P256.getPublicKey({ privateKey })
    const p256Signature = (payload: Hex) =>
      SignatureEnvelope.from({
        type: 'p256',
        signature: P256.sign({ payload, privateKey }),
        publicKey,
        prehash: false,
      })
    const envelope = unsignedOpen()
    expect(
      SponsorshipLimit.verifiedPayer(
        withSignature(envelope, p256Signature(TxEnvelopeTempo.getSignPayload(envelope))),
      ),
    ).toMatch(/^0x[0-9a-f]{40}$/)
    expect(
      SponsorshipLimit.verifiedPayer(
        withSignature(envelope, p256Signature(`0x${'00'.repeat(32)}`)),
      ),
    ).toBeNull()
  })

  test('keys an access-key transaction on the access key, not the claimed account', () => {
    const envelope = unsignedOpen()
    expect(
      SponsorshipLimit.verifiedPayer(withSignature(envelope, keychainSignature(envelope))),
    ).toBe(accessKey.address.toLowerCase())
  })

  test('keys an inline access-key authorization on the authorizing account', () => {
    const authorization = KeyAuthorization.from({
      address: accessKey.address,
      chainId: 4217n,
      type: 'secp256k1',
    })
    const envelope = unsignedOpen({
      keyAuthorization: KeyAuthorization.from({
        ...authorization,
        signature: SignatureEnvelope.from(
          Secp256k1.sign({
            payload: KeyAuthorization.getSignPayload(authorization),
            privateKey: payerKey,
          }),
        ),
      }),
    })
    expect(
      SponsorshipLimit.verifiedPayer(withSignature(envelope, keychainSignature(envelope))),
    ).toBe(payer.address.toLowerCase())
  })

  test.each(['', 'not-hex', '0x76deadbeef'])('returns no payer for %j', (transaction) => {
    expect(SponsorshipLimit.verifiedPayer(transaction)).toBeNull()
  })
})

describe('SponsorshipLimit.reserve', () => {
  test('allows the default five sponsored opens per payer per UTC day', async () => {
    const store = Store.memory()
    const now = new Date('2026-10-20T12:00:00.000Z')
    const reservations = await Promise.all(
      Array.from({ length: 6 }, () =>
        SponsorshipLimit.reserve(store, { action: 'open', chainId: 4217, payer: victim, now }),
      ),
    )
    expect(reservations.filter(Boolean)).toHaveLength(5)
    await expect(
      SponsorshipLimit.reserve(store, {
        action: 'open',
        chainId: 4217,
        payer: victim,
        now: new Date('2026-10-21T00:00:00.000Z'),
      }),
    ).resolves.toBe(true)
  })

  test('counts top-ups, chains, and payers separately', async () => {
    const store = Store.memory()
    const now = new Date('2026-10-20T12:00:00.000Z')
    const reserve = (parameters: { action: 'open' | 'topUp'; chainId: number; payer: string }) =>
      SponsorshipLimit.reserve(store, { ...parameters, now, perDay: 1 })
    await expect(reserve({ action: 'open', chainId: 4217, payer: victim })).resolves.toBe(true)
    await expect(reserve({ action: 'open', chainId: 4217, payer: victim })).resolves.toBe(false)
    await expect(reserve({ action: 'topUp', chainId: 4217, payer: victim })).resolves.toBe(true)
    await expect(reserve({ action: 'open', chainId: 42431, payer: victim })).resolves.toBe(true)
    await expect(reserve({ action: 'open', chainId: 4217, payer: payer.address })).resolves.toBe(
      true,
    )
  })
})

describe('SponsorshipLimit.limitFeePayer', () => {
  test('stops sponsoring a payer that used its daily opens', async () => {
    const limit = { perDay: 2, store: Store.memory() }
    const limitFeePayer = () =>
      SponsorshipLimit.limitFeePayer({
        chainId: 4217,
        feePayer: true as const,
        limit,
        payload: openPayload(),
      })
    await expect(limitFeePayer()).resolves.toBe(true)
    await expect(limitFeePayer()).resolves.toBe(true)
    await expect(limitFeePayer()).resolves.toBeUndefined()
  })

  test('does not spend the quota of the descriptor payer for another signer', async () => {
    const store = Store.memory()
    await SponsorshipLimit.limitFeePayer({
      chainId: 4217,
      feePayer: true,
      limit: { perDay: 1, store },
      payload: openPayload(),
    })
    await expect(
      SponsorshipLimit.reserve(store, { action: 'open', chainId: 4217, payer: victim, perDay: 1 }),
    ).resolves.toBe(true)
  })

  test('does not sponsor a transaction whose signatures prove no payer', async () => {
    await expect(
      SponsorshipLimit.limitFeePayer({
        chainId: 4217,
        feePayer: true,
        limit: { store: Store.memory() },
        payload: openPayload('0x76deadbeef'),
      }),
    ).resolves.toBeUndefined()
  })

  test('leaves vouchers, unsponsored requests, and unlimited servers alone', async () => {
    const store = Store.memory()
    const voucher: SessionCredentialPayload = {
      action: 'voucher',
      channelId: `0x${'11'.repeat(32)}`,
      cumulativeAmount: '1',
      descriptor: openPayload().descriptor!,
      signature: '0x1234',
    }
    await expect(
      SponsorshipLimit.limitFeePayer({
        chainId: 4217,
        feePayer: true,
        limit: { perDay: 0, store },
        payload: voucher,
      }),
    ).resolves.toBe(true)
    await expect(
      SponsorshipLimit.limitFeePayer({
        chainId: 4217,
        feePayer: undefined,
        limit: { perDay: 0, store },
        payload: openPayload(),
      }),
    ).resolves.toBeUndefined()
    await expect(
      SponsorshipLimit.limitFeePayer({
        chainId: 4217,
        feePayer: true,
        limit: undefined,
        payload: openPayload(),
      }),
    ).resolves.toBe(true)
  })
})
