import { createClient, custom, zeroAddress, type Address } from 'viem'
import { Account as TempoAccount, Secp256k1 } from 'viem/tempo'
import { describe, expect, test } from 'vp/test'

import * as defaults from './defaults.js'
import * as MachineTokenSession from './machine-token-session.js'

const mocks = vi.hoisted(() => ({ readContract: vi.fn() }))

vi.mock('viem/actions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('viem/actions')>()),
  readContract: mocks.readContract,
}))

const chainId = defaults.chainId.mainnet
const deployment = defaults.machineToken[chainId]
const merchant = '0x2222222222222222222222222222222222222222' as Address
const otherMerchant = '0x3333333333333333333333333333333333333333' as Address
const payer = '0x1111111111111111111111111111111111111111' as Address
const sessionPayee = '0x44d7c1edfdfdfdfdfdfdfdfd0000000000000001' as Address
const targetToken = '0x20c0000000000000000000000000000000000001' as Address
const overrideToken = '0x5555555555555555555555555555555555555555' as Address
const descriptor = {
  operator: deployment.swap,
  payee: sessionPayee,
  token: deployment.token,
} as const
const client = createClient({ transport: custom({ request: async () => undefined as never }) })
const route = { chainId, merchant, targetToken }
const matchedRoute = { ...route, descriptor }

function mockRoute(
  activePayee: Address = sessionPayee,
  binding: readonly [Address, Address] = [merchant, targetToken],
) {
  mocks.readContract.mockImplementation(
    (_client: unknown, { functionName }: { functionName: string }) =>
      functionName === 'sessionRouteFor' ? activePayee : binding,
  )
}

describe('Tempo machine-token sessions', () => {
  test('binds the configured route in both directions', async () => {
    mockRoute()
    await expect(
      Promise.all([
        MachineTokenSession.resolveRoute(client, route),
        MachineTokenSession.matchRoute(client, matchedRoute),
        MachineTokenSession.matchRoute(client, {
          ...matchedRoute,
          descriptor: { ...descriptor, operator: otherMerchant },
        }),
      ]),
    ).resolves.toEqual([descriptor, descriptor, undefined])

    mockRoute(sessionPayee, [otherMerchant, targetToken])
    await expect(MachineTokenSession.matchRoute(client, matchedRoute)).resolves.toBeUndefined()
  })

  test('requires the active route except for a historical close', async () => {
    mockRoute(zeroAddress)
    await expect(
      Promise.all([
        MachineTokenSession.matchRoute(client, matchedRoute),
        MachineTokenSession.matchRoute(client, { ...matchedRoute, active: false }),
      ]),
    ).resolves.toEqual([undefined, descriptor])
  })

  test('derives the management fee token from the payment rail', async () => {
    expect([
      MachineTokenSession.resolveFeeToken({ chainId, paymentToken: deployment.token }),
      MachineTokenSession.resolveFeeToken({ chainId, paymentToken: targetToken }),
      MachineTokenSession.resolveFeeToken({
        chainId,
        override: overrideToken,
        paymentToken: deployment.token,
      }),
    ]).toEqual([defaults.tokens.pathUsd, targetToken, overrideToken])
  })

  test('checks balance and signs router authorizations with an access key', async () => {
    mocks.readContract.mockResolvedValue(42n)
    const hasBalance = (amount: bigint) =>
      MachineTokenSession.hasSufficientBalance(client, {
        account: payer,
        amount,
        token: deployment.token,
      })
    await expect(Promise.all([42n, 43n].map(hasBalance))).resolves.toEqual([true, false])

    const root = TempoAccount.fromSecp256k1(Secp256k1.randomPrivateKey())
    const accessKey = TempoAccount.fromSecp256k1(Secp256k1.randomPrivateKey(), { access: root })
    const authorization = {
      channelId: `0x${'12'.repeat(32)}` as const,
      cumulativeAmount: 42n,
    }
    const authorizationContext = {
      authorization,
      chainId,
      router: deployment.swap,
    }
    const signature = await MachineTokenSession.signAuthorization(
      client,
      accessKey,
      authorizationContext,
    )
    const verify = (expectedSigner: Address) =>
      MachineTokenSession.verifyAuthorization({
        ...authorizationContext,
        expectedSigner,
        signature,
      })

    expect([verify(accessKey.accessKeyAddress), verify(root.address)]).toEqual([true, false])
  })
})
