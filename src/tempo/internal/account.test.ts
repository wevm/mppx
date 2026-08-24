import { privateKeyToAccount } from 'viem/accounts'
import { describe, expect, test } from 'vp/test'

import * as Account from './account.js'

const account = privateKeyToAccount(
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
)
const feePayer = privateKeyToAccount(
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
)

describe('resolve', () => {
  test('normalizes hosted fee-payer string shorthand', () => {
    expect(Account.resolve({ feePayer: 'https://sponsor.example' })).toMatchObject({
      feePayer: undefined,
      hostedFeePayer: { url: 'https://sponsor.example' },
    })
  })

  test('preserves hosted fee-payer headers without classifying them as an account', () => {
    const hostedFeePayer = {
      url: 'https://sponsor.example',
      headers: { Authorization: 'Bearer test' },
    } as const

    const resolved = Account.resolve({ feePayer: hostedFeePayer })

    expect(resolved.feePayer).toBeUndefined()
    expect(resolved.hostedFeePayer).toBe(hostedFeePayer)
  })

  test('preserves local account and account-sponsored modes', () => {
    expect(Account.resolve({ account, feePayer }).feePayer).toBe(feePayer)
    expect(Account.resolve({ account, feePayer: true }).feePayer).toBe(account)
  })
})
