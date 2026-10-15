import { privateKeyToAccount } from 'viem/accounts'
import { beforeEach, expect, test } from 'vp/test'

import * as Challenge from '../../Challenge.js'
import * as Credential from '../../Credential.js'
import * as Assets from '../../evm/Assets.js'
import { resolveAccount } from '../account.js'
import { evm } from './evm.js'

vi.mock('../account.js', () => ({ resolveAccount: vi.fn() }))
vi.mock('viem/actions', () => ({ readContract: vi.fn(async () => 'USDC') }))

const defaultAccount = privateKeyToAccount(
  '0x0000000000000000000000000000000000000000000000000000000000000001',
)
const selectedAccount = privateKeyToAccount(
  '0x0000000000000000000000000000000000000000000000000000000000000002',
)
const challenge = Challenge.from({
  id: 'selected-account',
  realm: 'example.com',
  method: 'evm',
  intent: 'charge',
  request: {
    amount: '1',
    currency: Assets.baseSepolia.USDC.address,
    recipient: '0x2222222222222222222222222222222222222222',
    methodDetails: { chainId: 84532, credentialTypes: ['authorization'] },
  },
})

beforeEach(() => {
  vi.mocked(resolveAccount).mockReset()
  vi.mocked(resolveAccount).mockImplementation(async (name) => {
    if (name === 'missing') throw new Error('Account "missing" not found.')
    return name === 'restricted' ? selectedAccount : defaultAccount
  })
})

test.each([
  { name: 'restricted', account: selectedAccount },
  { name: undefined, account: defaultAccount },
])('signs with the resolved account: $name', async ({ name, account }) => {
  const result = await evm().setup({ challenge, options: { account: name }, methodOpts: {} })
  const credential = Credential.deserialize(
    await result.methods[0]!.createCredential({ challenge, context: {} }),
  )
  expect(resolveAccount).toHaveBeenCalledExactlyOnceWith(name)
  expect(credential.payload).toMatchObject({ from: account.address })
})

test('does not fall back when the selected account is missing', async () => {
  await expect(
    evm().setup({ challenge, options: { account: 'missing' }, methodOpts: {} }),
  ).rejects.toThrow('Account "missing" not found.')
  expect(resolveAccount).toHaveBeenCalledExactlyOnceWith('missing')
})
