import { type Hex, P256, Secp256k1, Signature } from 'ox'
import { AccountConfig, SignatureEnvelope } from 'ox/tempo'
import { createClient, hashTypedData, http } from 'viem'
import { privateKeyToAccount, toAccount } from 'viem/accounts'
import { signTypedData } from 'viem/actions'
import { Account as TempoAccount } from 'viem/tempo'
import { describe, expect, test } from 'vp/test'

import { tip20ChannelEscrow } from './Protocol.js'
import { uint96 } from './Protocol.js'
import {
  getVoucherDomain,
  parseVoucherFromPayload,
  signCloseAuthorization,
  signVoucher,
  verifyCloseAuthorization,
  voucherTypes,
  verifyVoucher,
} from './Voucher.js'

const account = privateKeyToAccount(
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
)
const escrowContract = tip20ChannelEscrow
const chainId = 42431

const client = createClient({
  account,
  transport: http('http://127.0.0.1'), // only used for local signTypedData
})

const channelId = '0x0000000000000000000000000000000000000000000000000000000000000001' as const
const cumulativeAmount = uint96(1_000_000n)

const secp256k1Order = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n
const p256Order = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n

/** Returns the high-s twin of a secp256k1 signature: it recovers the same signer, but Tempo rejects it. */
function toHighS(signature: Hex.Hex): Hex.Hex {
  const { r, s, yParity } = Signature.fromHex(signature)
  return Signature.toHex({ r, s: secp256k1Order - s, yParity: yParity === 0 ? 1 : 0 })
}

describe('Precompile Voucher', () => {
  test('sign and verify round-trip', async () => {
    const signature = await signVoucher(
      client,
      account,
      { channelId, cumulativeAmount },
      escrowContract,
      chainId,
    )
    expect(signature).toMatch(/^0x/)
    expect(signature.length).toBe(132)

    const isValid = verifyVoucher(
      escrowContract,
      chainId,
      { channelId, cumulativeAmount, signature },
      account.address,
    )
    expect(isValid).toBe(true)
  })

  test('verify rejects wrong signer', async () => {
    const signature = await signVoucher(
      client,
      account,
      { channelId, cumulativeAmount },
      escrowContract,
      chainId,
    )

    const wrongAddress = '0x0000000000000000000000000000000000000001' as const
    const isValid = verifyVoucher(
      escrowContract,
      chainId,
      { channelId, cumulativeAmount, signature },
      wrongAddress,
    )
    expect(isValid).toBe(false)
  })

  test('verify rejects tampered amount', async () => {
    const signature = await signVoucher(
      client,
      account,
      { channelId, cumulativeAmount },
      escrowContract,
      chainId,
    )

    const isValid = verifyVoucher(
      escrowContract,
      chainId,
      { channelId, cumulativeAmount: uint96(9_999_999n), signature },
      account.address,
    )
    expect(isValid).toBe(false)
  })

  test('verify rejects tampered channelId', async () => {
    const signature = await signVoucher(
      client,
      account,
      { channelId, cumulativeAmount },
      escrowContract,
      chainId,
    )

    const wrongChannelId =
      '0x0000000000000000000000000000000000000000000000000000000000000099' as const
    const isValid = verifyVoucher(
      escrowContract,
      chainId,
      { channelId: wrongChannelId, cumulativeAmount, signature },
      account.address,
    )
    expect(isValid).toBe(false)
  })

  test('verify rejects wrong chain ID', async () => {
    const signature = await signVoucher(
      client,
      account,
      { channelId, cumulativeAmount },
      escrowContract,
      chainId,
    )

    const isValid = verifyVoucher(
      escrowContract,
      99999,
      { channelId, cumulativeAmount, signature },
      account.address,
    )
    expect(isValid).toBe(false)
  })

  test('signs and verifies custom escrow domain with EIP-712', async () => {
    const customEscrow = '0x0000000000000000000000000000000000000005' as const
    const signature = await signVoucher(
      client,
      account,
      { channelId, cumulativeAmount },
      customEscrow,
      chainId,
    )

    expect(
      verifyVoucher(
        customEscrow,
        chainId,
        { channelId, cumulativeAmount, signature },
        account.address,
      ),
    ).toBe(true)
  })

  test('verify returns false for invalid signature', () => {
    const isValid = verifyVoucher(
      escrowContract,
      chainId,
      { channelId, cumulativeAmount, signature: '0xdeadbeef' },
      account.address,
    )
    expect(isValid).toBe(false)
  })

  test('parseVoucherFromPayload', () => {
    const signature =
      '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890ab' as const
    const voucher = parseVoucherFromPayload(channelId, '5000000', signature)
    expect(voucher.channelId).toBe(channelId)
    expect(voucher.cumulativeAmount).toBe(5_000_000n)
    expect(voucher.signature).toBe(signature)
  })

  test('parseVoucherFromPayload with zero amount', () => {
    const signature =
      '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890ab' as const
    const voucher = parseVoucherFromPayload(channelId, '0', signature)
    expect(voucher.cumulativeAmount).toBe(0n)
  })

  test('parseVoucherFromPayload rejects amounts outside uint96 bounds', () => {
    const signature = '0xdeadbeef' as const
    expect(() => parseVoucherFromPayload(channelId, '-1', signature)).toThrow(
      'outside uint96 bounds',
    )
    expect(() => parseVoucherFromPayload(channelId, (1n << 96n).toString(), signature)).toThrow(
      'outside uint96 bounds',
    )
  })

  test('verify rejects wrong escrow contract', async () => {
    const signature = await signVoucher(
      client,
      account,
      { channelId, cumulativeAmount },
      escrowContract,
      chainId,
    )

    const wrongEscrow = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd' as const
    const isValid = verifyVoucher(
      wrongEscrow,
      chainId,
      { channelId, cumulativeAmount, signature },
      account.address,
    )
    expect(isValid).toBe(false)
  })

  test('sign and verify round-trip with zero amount', async () => {
    const zeroAmount = uint96(0n)
    const signature = await signVoucher(
      client,
      account,
      { channelId, cumulativeAmount: zeroAmount },
      escrowContract,
      chainId,
    )
    expect(signature).toMatch(/^0x/)

    const isValid = verifyVoucher(
      escrowContract,
      chainId,
      { channelId, cumulativeAmount: zeroAmount, signature },
      account.address,
    )
    expect(isValid).toBe(true)
  })

  test('verify rejects direct keychain wrapper signatures', async () => {
    const signature = await signTypedData(client, {
      account,
      domain: getVoucherDomain(escrowContract, chainId),
      types: voucherTypes,
      primaryType: 'Voucher',
      message: { channelId, cumulativeAmount },
    })
    const envelope = SignatureEnvelope.from(signature as SignatureEnvelope.Serialized)
    const wrapped = SignatureEnvelope.serialize(
      {
        inner: envelope,
        type: 'keychain',
        userAddress: account.address,
        version: 'v1',
      },
      { magic: true },
    )

    expect(
      verifyVoucher(
        escrowContract,
        chainId,
        { channelId, cumulativeAmount, signature: wrapped },
        account.address,
      ),
    ).toBe(false)
  })

  test('verify rejects magic-suffixed secp256k1 signatures', async () => {
    const signature = await signTypedData(client, {
      account,
      domain: getVoucherDomain(escrowContract, chainId),
      types: voucherTypes,
      primaryType: 'Voucher',
      message: { channelId, cumulativeAmount },
    })
    const envelope = SignatureEnvelope.from(signature as SignatureEnvelope.Serialized)
    const suffixed = SignatureEnvelope.serialize(envelope, { magic: true })

    expect(
      verifyVoucher(
        escrowContract,
        chainId,
        { channelId, cumulativeAmount, signature: suffixed },
        account.address,
      ),
    ).toBe(false)
  })

  test('verify rejects the high-s twin of a valid voucher', async () => {
    const signature = await signVoucher(
      client,
      account,
      { channelId, cumulativeAmount },
      escrowContract,
      chainId,
    )
    const highS = toHighS(signature)
    const payload = hashTypedData({
      domain: getVoucherDomain(escrowContract, chainId),
      types: voucherTypes,
      primaryType: 'Voucher',
      message: { channelId, cumulativeAmount },
    })
    // The twin still recovers the signer: only the low-s rule rejects it.
    expect(
      Secp256k1.recoverAddress({ payload, signature: Signature.fromHex(highS) }).toLowerCase(),
    ).toBe(account.address.toLowerCase())

    expect(
      verifyVoucher(
        escrowContract,
        chainId,
        { channelId, cumulativeAmount, signature },
        account.address,
      ),
    ).toBe(true)
    expect(
      verifyVoucher(
        escrowContract,
        chainId,
        { channelId, cumulativeAmount, signature: highS },
        account.address,
      ),
    ).toBe(false)
  })

  test('signVoucher and signCloseAuthorization normalize high-s signers', async () => {
    // A signer that returns the high-s twin of each signature, as some KMS backends do.
    const highSAccount = toAccount({
      address: account.address,
      async signMessage() {
        throw new Error('unused')
      },
      async signTransaction() {
        throw new Error('unused')
      },
      async signTypedData(parameters) {
        return toHighS(await account.signTypedData(parameters as never))
      },
    })
    const highSClient = createClient({
      account: highSAccount,
      transport: http('http://127.0.0.1'),
    })
    const voucher = { channelId, cumulativeAmount }

    const signature = await signVoucher(highSClient, highSAccount, voucher, escrowContract, chainId)
    expect(signature).toBe(await signVoucher(client, account, voucher, escrowContract, chainId))
    expect(verifyVoucher(escrowContract, chainId, { ...voucher, signature }, account.address)).toBe(
      true,
    )

    const close = await signCloseAuthorization(
      highSClient,
      highSAccount,
      voucher,
      escrowContract,
      chainId,
    )
    expect(
      verifyCloseAuthorization(escrowContract, chainId, { ...voucher, signature: close }, [
        account.address,
      ]),
    ).toBe(true)
  })

  test('verifyCloseAuthorization rejects high-s signatures', async () => {
    const signature = await signCloseAuthorization(
      client,
      account,
      { channelId, cumulativeAmount },
      escrowContract,
      chainId,
    )
    expect(
      verifyCloseAuthorization(
        escrowContract,
        chainId,
        { channelId, cumulativeAmount, signature },
        [account.address],
      ),
    ).toBe(true)
    expect(
      verifyCloseAuthorization(
        escrowContract,
        chainId,
        { channelId, cumulativeAmount, signature: toHighS(signature) },
        [account.address],
      ),
    ).toBe(false)
  })

  test('verify rejects high-s p256 vouchers', async () => {
    const rootAccount = TempoAccount.fromSecp256k1(Secp256k1.randomPrivateKey())
    const accessKey = TempoAccount.fromP256(P256.randomPrivateKey(), { access: rootAccount })
    const signature = await signVoucher(
      createClient({ account: accessKey, transport: http('http://127.0.0.1') }),
      accessKey,
      { channelId, cumulativeAmount },
      escrowContract,
      chainId,
    )
    const envelope = SignatureEnvelope.from(
      signature as SignatureEnvelope.Serialized,
    ) as SignatureEnvelope.P256
    const highS = SignatureEnvelope.serialize({
      ...envelope,
      signature: { ...envelope.signature, s: p256Order - envelope.signature.s },
    })
    expect(
      verifyVoucher(
        escrowContract,
        chainId,
        { channelId, cumulativeAmount, signature: highS },
        accessKey.accessKeyAddress,
      ),
    ).toBe(false)
  })

  test('signs and verifies p256 access-key vouchers as primitives', async () => {
    const rootAccount = TempoAccount.fromSecp256k1(Secp256k1.randomPrivateKey())
    const accessKey = TempoAccount.fromP256(P256.randomPrivateKey(), {
      access: rootAccount,
    })
    const accessKeyClient = createClient({
      account: accessKey,
      transport: http('http://127.0.0.1'),
    })

    const signature = await signVoucher(
      accessKeyClient,
      accessKey,
      { channelId, cumulativeAmount },
      escrowContract,
      chainId,
    )

    const envelope = SignatureEnvelope.from(signature as SignatureEnvelope.Serialized)
    expect(envelope.type).toBe('p256')
    expect(
      verifyVoucher(
        escrowContract,
        chainId,
        { channelId, cumulativeAmount, signature },
        accessKey.accessKeyAddress,
      ),
    ).toBe(true)
  })

  test('signs p256 access-key close authorizations as primitives', async () => {
    const rootAccount = TempoAccount.fromSecp256k1(Secp256k1.randomPrivateKey())
    const accessKey = TempoAccount.fromP256(P256.randomPrivateKey(), {
      access: rootAccount,
    })
    const accessKeyClient = createClient({
      account: accessKey,
      transport: http('http://127.0.0.1'),
    })

    const signature = await signCloseAuthorization(
      accessKeyClient,
      accessKey,
      { channelId, cumulativeAmount },
      escrowContract,
      chainId,
    )

    const envelope = SignatureEnvelope.from(signature as SignatureEnvelope.Serialized)
    expect(envelope.type).toBe('p256')
    expect(
      verifyCloseAuthorization(
        escrowContract,
        chainId,
        { channelId, cumulativeAmount, signature },
        [rootAccount.address, accessKey.accessKeyAddress],
      ),
    ).toBe(true)
    // A close authorization is not a voucher.
    expect(
      verifyVoucher(
        escrowContract,
        chainId,
        { channelId, cumulativeAmount, signature },
        accessKey.accessKeyAddress,
      ),
    ).toBe(false)
  })

  test('signs and verifies webAuthn root vouchers as primitives', async () => {
    const webAuthnAccount = TempoAccount.fromHeadlessWebAuthn(P256.randomPrivateKey(), {
      origin: 'https://example.com',
      rpId: 'example.com',
    })
    const webAuthnClient = createClient({
      account: webAuthnAccount,
      transport: http('http://127.0.0.1'),
    })

    const signature = await signVoucher(
      webAuthnClient,
      webAuthnAccount,
      { channelId, cumulativeAmount },
      escrowContract,
      chainId,
    )

    const envelope = SignatureEnvelope.from(signature as SignatureEnvelope.Serialized)
    expect(envelope.type).toBe('webAuthn')
    expect(
      verifyVoucher(
        escrowContract,
        chainId,
        { channelId, cumulativeAmount, signature },
        webAuthnAccount.address,
      ),
    ).toBe(true)
  })

  test('domain and type match TIP-1034', () => {
    expect(getVoucherDomain(escrowContract, chainId)).toEqual({
      name: 'TIP20 Channel Reserve',
      version: '1',
      chainId,
      verifyingContract: escrowContract,
    })
    expect(voucherTypes.Voucher).toEqual([
      { name: 'channelId', type: 'bytes32' },
      { name: 'cumulativeAmount', type: 'uint96' },
    ])
    expect(
      hashTypedData({
        domain: getVoucherDomain(escrowContract, chainId),
        types: voucherTypes,
        primaryType: 'Voucher',
        message: { channelId, cumulativeAmount },
      }),
    ).toMatch(/^0x[0-9a-f]{64}$/)
  })
})

describe('TIP-1166 configurable account vouchers', () => {
  const ownerA = TempoAccount.fromSecp256k1(Secp256k1.randomPrivateKey())
  const ownerB = TempoAccount.fromSecp256k1(Secp256k1.randomPrivateKey())
  const ownerC = TempoAccount.fromSecp256k1(Secp256k1.randomPrivateKey())

  /** A 2-of-2 configurable account whose address its version-zero config derives. */
  const initial = TempoAccount.fromConfig({ owners: [ownerA, ownerB], threshold: 2 })
  /** The same account after its config rotated to version 1 with another owner set. */
  const rotated = TempoAccount.fromConfig({
    address: initial.address,
    owners: [ownerA, ownerC],
    salt: initial.config!.salt,
    threshold: 2,
    version: 1,
  })
  const initialCommitment = AccountConfig.getCommitment(initial.config!)
  const rotatedCommitment = AccountConfig.getCommitment(rotated.config!)

  function clientFor(signer: typeof initial) {
    return createClient({ account: signer, transport: http('http://127.0.0.1') })
  }

  async function sign(signer: typeof initial, amount = cumulativeAmount) {
    const signature = await signVoucher(
      clientFor(signer),
      signer,
      { channelId, cumulativeAmount: amount },
      escrowContract,
      chainId,
    )
    return { channelId, cumulativeAmount: amount, signature }
  }

  test('signs vouchers with a configurable account envelope', async () => {
    const voucher = await sign(initial)
    const envelope = SignatureEnvelope.from(voucher.signature as SignatureEnvelope.Serialized)
    expect(envelope.type).toBe('configurable')
  })

  test('rejects configurable account vouchers by default', async () => {
    const voucher = await sign(initial)
    expect(verifyVoucher(escrowContract, chainId, voucher, initial.address)).toBe(false)
    expect(
      verifyVoucher(escrowContract, chainId, voucher, initial.address, {
        openingCommitment: initialCommitment,
      }),
    ).toBe(false)
  })

  test('accepts a configurable account voucher whose config matches the opening commitment', async () => {
    const voucher = await sign(rotated)
    expect(
      verifyVoucher(escrowContract, chainId, voucher, rotated.address, {
        configurable: true,
        openingCommitment: rotatedCommitment,
      }),
    ).toBe(true)
  })

  test('rejects a configurable account voucher after the config rotated', async () => {
    const voucher = await sign(rotated)
    expect(
      verifyVoucher(escrowContract, chainId, voucher, rotated.address, {
        configurable: true,
        openingCommitment: initialCommitment,
      }),
    ).toBe(false)
  })

  test('accepts the version-zero config that derives the signer without an opening commitment', async () => {
    const voucher = await sign(initial)
    expect(AccountConfig.getAddress(initial.config!).toLowerCase()).toBe(
      initial.address.toLowerCase(),
    )
    expect(
      verifyVoucher(escrowContract, chainId, voucher, initial.address, { configurable: true }),
    ).toBe(true)
    expect(
      verifyVoucher(escrowContract, chainId, voucher, initial.address, {
        configurable: true,
        openingCommitment: `0x${'00'.repeat(32)}`,
      }),
    ).toBe(true)
  })

  test('rejects a non-zero version config without an opening commitment', async () => {
    const voucher = await sign(rotated)
    expect(
      verifyVoucher(escrowContract, chainId, voucher, rotated.address, { configurable: true }),
    ).toBe(false)
  })

  test('rejects a configurable account voucher for another signer', async () => {
    const voucher = await sign(initial)
    expect(
      verifyVoucher(escrowContract, chainId, voucher, ownerA.address, { configurable: true }),
    ).toBe(false)
  })

  test('rejects a configurable account voucher for another amount', async () => {
    const voucher = await sign(initial)
    expect(
      verifyVoucher(
        escrowContract,
        chainId,
        { ...voucher, cumulativeAmount: uint96(cumulativeAmount + 1n) },
        initial.address,
        { configurable: true },
      ),
    ).toBe(false)
  })

  test('rejects a configurable account voucher below the threshold', async () => {
    const voucher = await sign(initial)
    const envelope = SignatureEnvelope.from(
      voucher.signature as SignatureEnvelope.Serialized,
    ) as SignatureEnvelope.Configurable
    const signature = SignatureEnvelope.serialize({
      ...envelope,
      signatures: envelope.signatures.slice(0, 1),
    })
    expect(
      verifyVoucher(escrowContract, chainId, { ...voucher, signature }, initial.address, {
        configurable: true,
      }),
    ).toBe(false)
  })

  test('rejects a configurable account voucher with a high-s approval', async () => {
    const voucher = await sign(initial)
    const envelope = SignatureEnvelope.from(
      voucher.signature as SignatureEnvelope.Serialized,
    ) as SignatureEnvelope.Configurable
    const [first, ...rest] = envelope.signatures
    if (first?.type !== 'secp256k1') throw new Error('expected a secp256k1 approval')
    const signature = SignatureEnvelope.serialize({
      ...envelope,
      signatures: [
        {
          ...first,
          signature: Signature.fromHex(toHighS(Signature.toHex(first.signature))),
        },
        ...rest,
      ],
    })
    expect(
      verifyVoucher(escrowContract, chainId, voucher, initial.address, { configurable: true }),
    ).toBe(true)
    expect(
      verifyVoucher(escrowContract, chainId, { ...voucher, signature }, initial.address, {
        configurable: true,
      }),
    ).toBe(false)
  })

  test('rejects configurable account approvals out of owner order', async () => {
    const voucher = await sign(initial)
    const envelope = SignatureEnvelope.from(
      voucher.signature as SignatureEnvelope.Serialized,
    ) as SignatureEnvelope.Configurable
    const signature = SignatureEnvelope.serialize({
      ...envelope,
      signatures: [...envelope.signatures].reverse(),
    })
    expect(
      verifyVoucher(escrowContract, chainId, { ...voucher, signature }, initial.address, {
        configurable: true,
      }),
    ).toBe(false)
  })

  test('rejects excess configurable account approvals', async () => {
    const oneOfTwo = TempoAccount.fromConfig({ owners: [ownerA, ownerB], threshold: 1 })
    const payload = hashTypedData({
      domain: getVoucherDomain(escrowContract, chainId),
      types: voucherTypes,
      primaryType: 'Voucher',
      message: { channelId, cumulativeAmount },
    })
    const digest = AccountConfig.getSignPayload({
      account: oneOfTwo.address,
      config: oneOfTwo.config!,
      payload,
    })
    const approvals = await Promise.all(
      [ownerA, ownerB].map(async (owner) =>
        SignatureEnvelope.from(
          (await owner.sign({ hash: digest })) as SignatureEnvelope.Serialized,
        ),
      ),
    )
    const sorted = approvals
      .map((approval, index) => ({ approval, owner: [ownerA, ownerB][index]!.address }))
      .sort((a, b) => (BigInt(a.owner) < BigInt(b.owner) ? -1 : 1))
      .map(({ approval }) => approval)
    const signature = SignatureEnvelope.serialize({
      account: oneOfTwo.address,
      config: oneOfTwo.config!,
      signatures: sorted,
      type: 'configurable',
    } as SignatureEnvelope.Configurable)
    const options = { configurable: true }
    expect(
      verifyVoucher(
        escrowContract,
        chainId,
        { channelId, cumulativeAmount, signature },
        oneOfTwo.address,
        options,
      ),
    ).toBe(false)
    const single = SignatureEnvelope.serialize({
      account: oneOfTwo.address,
      config: oneOfTwo.config!,
      signatures: sorted.slice(0, 1),
      type: 'configurable',
    } as SignatureEnvelope.Configurable)
    expect(
      verifyVoucher(
        escrowContract,
        chainId,
        { channelId, cumulativeAmount, signature: single },
        oneOfTwo.address,
        options,
      ),
    ).toBe(true)
  })

  test('rejects a primitive voucher when the opening commitment is nonzero', async () => {
    const signature = await signVoucher(
      client,
      account,
      { channelId, cumulativeAmount },
      escrowContract,
      chainId,
    )
    const voucher = { channelId, cumulativeAmount, signature }
    expect(
      verifyVoucher(escrowContract, chainId, voucher, account.address, {
        configurable: true,
        openingCommitment: initialCommitment,
      }),
    ).toBe(false)
    expect(
      verifyVoucher(escrowContract, chainId, voucher, account.address, {
        openingCommitment: initialCommitment,
      }),
    ).toBe(false)
  })

  test('keeps accepting primitive vouchers without an opening commitment', async () => {
    const signature = await signVoucher(
      client,
      account,
      { channelId, cumulativeAmount },
      escrowContract,
      chainId,
    )
    const voucher = { channelId, cumulativeAmount, signature }
    expect(verifyVoucher(escrowContract, chainId, voucher, account.address)).toBe(true)
    expect(verifyVoucher(escrowContract, chainId, voucher, account.address, {})).toBe(true)
    expect(
      verifyVoucher(escrowContract, chainId, voucher, account.address, { configurable: true }),
    ).toBe(true)
  })

  test('applies the opening commitment only to the voucher signer of a close authorization', async () => {
    const authorization = { channelId, cumulativeAmount }
    const signature = await signCloseAuthorization(
      client,
      account,
      authorization,
      escrowContract,
      chainId,
    )
    const signed = { ...authorization, signature }
    const signers = [account.address, rotated.address]
    const options = { configurable: true, openingCommitment: rotatedCommitment }
    // The primitive payer is not bound by the voucher signer's opening commitment.
    expect(
      verifyCloseAuthorization(escrowContract, chainId, signed, signers, {
        ...options,
        voucherSigner: rotated.address,
      }),
    ).toBe(true)
    // When the payer is the voucher signer, a nonzero opening commitment rejects its primitive signature.
    expect(
      verifyCloseAuthorization(escrowContract, chainId, signed, [account.address], {
        ...options,
        voucherSigner: account.address,
      }),
    ).toBe(false)
  })

  test('verifies configurable account close authorizations under the same rules', async () => {
    const authorization = { channelId, cumulativeAmount }
    const signature = await signCloseAuthorization(
      clientFor(rotated),
      rotated,
      authorization,
      escrowContract,
      chainId,
    )
    const signed = { ...authorization, signature }
    const signers = [account.address, rotated.address]
    expect(verifyCloseAuthorization(escrowContract, chainId, signed, signers)).toBe(false)
    expect(
      verifyCloseAuthorization(escrowContract, chainId, signed, signers, {
        configurable: true,
        openingCommitment: rotatedCommitment,
      }),
    ).toBe(true)
    expect(
      verifyCloseAuthorization(escrowContract, chainId, signed, signers, {
        configurable: true,
        openingCommitment: initialCommitment,
      }),
    ).toBe(false)
  })

  test('rejects a configurable close authorization from a payer that is not the voucher signer', async () => {
    const authorization = { channelId, cumulativeAmount }
    const signature = await signCloseAuthorization(
      clientFor(initial),
      initial,
      authorization,
      escrowContract,
      chainId,
    )
    const signed = { ...authorization, signature }
    const signers = [initial.address, account.address]
    // No opening commitment binds the payer's config, so its version-zero owners may be superseded.
    expect(
      verifyCloseAuthorization(escrowContract, chainId, signed, signers, {
        configurable: true,
        voucherSigner: account.address,
      }),
    ).toBe(false)
    expect(
      verifyCloseAuthorization(escrowContract, chainId, signed, signers, {
        configurable: true,
        voucherSigner: initial.address,
      }),
    ).toBe(true)
  })

  test('accepts an upgraded account whose later config lists the account as an owner', async () => {
    // A TIP-1113 upgrade may keep the original key: the account owns itself from version 1.
    const upgraded = TempoAccount.fromConfig({
      address: ownerA.address,
      owners: [ownerA, ownerB],
      salt: `0x${'00'.repeat(32)}`,
      threshold: 2,
      version: 1,
    })
    const voucher = await sign(upgraded)
    expect(
      verifyVoucher(escrowContract, chainId, voucher, ownerA.address, {
        configurable: true,
        openingCommitment: AccountConfig.getCommitment(upgraded.config!),
      }),
    ).toBe(true)
  })
})
