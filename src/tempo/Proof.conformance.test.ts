import { recoverTypedDataAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { describe, expect, test } from 'vp/test'

import * as Proof from './Proof.js'

/**
 * Deterministic conformance vector for the wallet-bound Tempo proof contract
 * (EIP-712 domain `MPP` version `3`). These values pin the on-the-wire
 * signing payload so any change to the proof ABI is caught here.
 */
const vector = {
  account: '0x1a642f0E3c3aF545E7AcBD38b07251B3990914F1',
  chainId: 42431,
  challengeId: 'kM9xPqWvT2nJrHsY4aDfEb',
  digest: '0x3860a700a55e02ad3c2dc047e92489feceecbdb0a801d948e1d9f0b61ea9bc3f',
  privateKey: `0x${'01'.repeat(32)}`,
  realm: 'api.example.com',
  signature:
    '0x53f5d64d9f995e841b4212639b2e17e508e96752e10316df3814a16443dcbdb626c082190a4c3ecc3148101eb443d15bd83b579380b1be735a9c99f0df36c9fe1b',
} as const

const params = {
  account: vector.account,
  chainId: vector.chainId,
  challengeId: vector.challengeId,
  realm: vector.realm,
} as const

describe('tempo.Proof conformance (wallet binding)', () => {
  test('typedData is the canonical wallet-bound MPP v3 proof contract', () => {
    expect(Proof.typedData(params)).toEqual({
      domain: { name: 'MPP', version: '3', chainId: vector.chainId },
      types: {
        Proof: [
          { name: 'account', type: 'address' },
          { name: 'challengeId', type: 'string' },
          { name: 'realm', type: 'string' },
        ],
      },
      primaryType: 'Proof',
      message: {
        account: vector.account,
        challengeId: vector.challengeId,
        realm: vector.realm,
      },
    })
  })

  test('hash matches the deterministic EIP-712 digest vector', () => {
    expect(Proof.hash(params)).toBe(vector.digest)
  })

  test('the wallet produces the deterministic signature vector', async () => {
    const account = privateKeyToAccount(vector.privateKey)
    expect(account.address).toBe(vector.account)
    const signature = await account.signTypedData(Proof.typedData(params))
    expect(signature).toBe(vector.signature)
  })

  test('the signature vector recovers to the bound wallet', async () => {
    const recovered = await recoverTypedDataAddress({
      ...Proof.typedData(params),
      signature: vector.signature,
    })
    expect(recovered).toBe(vector.account)
  })

  test('the digest is bound to the wallet: a different account changes the digest', () => {
    const other = '0x000000000000000000000000000000000000dEaD'
    expect(Proof.hash({ ...params, account: other })).not.toBe(vector.digest)
  })

  test('a proof cannot be replayed against a different wallet for the same challenge', async () => {
    const account = privateKeyToAccount(vector.privateKey)
    const signature = await account.signTypedData(Proof.typedData(params))

    // An attacker swaps the bound `account` to a wallet they want to impersonate
    // while keeping the same challenge. Because `account` is a signed field, the
    // recovered signer no longer matches the swapped wallet, so verification
    // (and the access-key delegation check, which rebuilds the message from the
    // claimed source) fails.
    const swapped = '0x000000000000000000000000000000000000dEaD'
    const recovered = await recoverTypedDataAddress({
      ...Proof.typedData({ ...params, account: swapped }),
      signature,
    })
    expect(recovered).not.toBe(swapped)
    expect(recovered).not.toBe(vector.account)
  })

  test('models the access-key delegation path: swapping the source breaks signer recovery', async () => {
    // An access key K signs a proof bound to root account A. The server's
    // delegation check recovers the signer from the message it rebuilds using
    // the *claimed* source, then requires `isActiveAccessKey(signer, source)`.
    // Distinct access key (signer) and root account (the bound payer / source).
    const accessKey = privateKeyToAccount(`0x${'02'.repeat(32)}`)
    const rootA = vector.account // proof is signed bound to account = A
    const signature = await accessKey.signTypedData(Proof.typedData({ ...params, account: rootA }))
    expect(accessKey.address).not.toBe(rootA)

    // Honest submission (source = A): server recovers exactly K, so
    // isActiveAccessKey(K, A) — the key actually authorized for A — is checked.
    const recoveredForA = await recoverTypedDataAddress({
      ...Proof.typedData({ ...params, account: rootA }),
      signature,
    })
    expect(recoveredForA).toBe(accessKey.address)

    // Replay against a different root B (attacker swaps source to B): server
    // rebuilds the message with account = B, recovering some K' != K. Even if K
    // is an active access key of B, the server checks isActiveAccessKey(K', B),
    // which cannot match the authorized key. Replay is rejected.
    const rootB = '0x000000000000000000000000000000000000bEEF'
    const recoveredForB = await recoverTypedDataAddress({
      ...Proof.typedData({ ...params, account: rootB }),
      signature,
    })
    expect(recoveredForB).not.toBe(accessKey.address)
  })

  test('a legacy v2 proof (no account field) does not verify under the v3 contract', async () => {
    // The pre-binding contract: domain version "2", message without `account`.
    const account = privateKeyToAccount(vector.privateKey)
    const legacyTypedData = {
      domain: { name: 'MPP', version: '2', chainId: vector.chainId },
      types: {
        Proof: [
          { name: 'challengeId', type: 'string' },
          { name: 'realm', type: 'string' },
        ],
      },
      primaryType: 'Proof',
      message: { challengeId: vector.challengeId, realm: vector.realm },
    } as const
    const legacySignature = await account.signTypedData(legacyTypedData)

    // Verified against the current wallet-bound v3 contract, recovery yields a
    // different address, so the server rejects stale v2 proofs.
    const recovered = await recoverTypedDataAddress({
      ...Proof.typedData(params),
      signature: legacySignature,
    })
    expect(recovered).not.toBe(account.address)
  })
})
