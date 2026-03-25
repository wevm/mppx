import { createClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { mainnet } from 'viem/chains'
import { describe, expect, test } from 'vp/test'

import * as Account from './Account.js'

const account = privateKeyToAccount(
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
)

const otherAccount = privateKeyToAccount(
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
)

const clientWithAccount = createClient({
  account,
  chain: mainnet,
  transport: http(),
})

const clientWithoutAccount = createClient({
  chain: mainnet,
  transport: http(),
})

describe('getResolver', () => {
  test('behavior: returns Account when passed as default', () => {
    const getAccount = Account.getResolver({ account })
    const result = getAccount(clientWithoutAccount)
    expect(result).toBe(account)
  })

  test('behavior: returns Account when passed as override', () => {
    const getAccount = Account.getResolver()
    const result = getAccount(clientWithoutAccount, { account: otherAccount })
    expect(result).toBe(otherAccount)
  })

  test('behavior: override takes precedence over default', () => {
    const getAccount = Account.getResolver({ account })
    const result = getAccount(clientWithoutAccount, { account: otherAccount })
    expect(result).toBe(otherAccount)
  })

  test('behavior: falls back to client.account when no account provided', () => {
    const getAccount = Account.getResolver()
    const result = getAccount(clientWithAccount)
    expect(result).toBe(account)
  })

  test('behavior: Address returns parsed account', () => {
    const getAccount = Account.getResolver()
    const result = getAccount(clientWithoutAccount, { account: account.address })
    expect(result.address).toBe(account.address)
    expect(result.type).toBe('json-rpc')
  })

  test('behavior: Address as default returns parsed account', () => {
    const getAccount = Account.getResolver({ account: account.address })
    const result = getAccount(clientWithoutAccount)
    expect(result.address).toBe(account.address)
    expect(result.type).toBe('json-rpc')
  })

  test('error: throws when no account and client has no account', () => {
    const getAccount = Account.getResolver()
    expect(() => getAccount(clientWithoutAccount)).toThrowErrorMatchingInlineSnapshot(
      `[Error: No \`account\` provided. Pass \`account\` to parameters or context.]`,
    )
  })
})
