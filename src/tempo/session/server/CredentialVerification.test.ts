import { zeroAddress, type Address, type Hex } from 'viem'
import { afterEach, describe, expect, test, vi } from 'vp/test'

import * as Challenge from '../../../Challenge.js'
import * as Store from '../../../Store.js'
import * as defaults from '../../internal/defaults.js'
import * as MachineTokenSession from '../../internal/machine-token-session.js'
import * as Channel from '../precompile/Channel.js'
import * as Voucher from '../precompile/Voucher.js'
import * as ChannelStore from './ChannelStore.js'
import {
  assertOpenCredentialCoversRequest,
  broadcastCredentialPayload,
  requireSessionCredentialAction,
  requireSessionCredentialPayload,
  requireSessionCredentialPayloadHeader,
  type ValidateCredentialPayloadParameters,
  validateChannelDescriptor,
  validateCredentialPayload,
} from './CredentialVerification.js'

describe('SessionCredentialGuards', () => {
  const channelId = `0x${'aa'.repeat(32)}` as Hex
  const descriptor = {
    authorizedSigner: '0x0000000000000000000000000000000000000001',
    expiringNonceHash: `0x${'11'.repeat(32)}`,
    operator: '0x0000000000000000000000000000000000000000',
    payee: '0x0000000000000000000000000000000000000002',
    payer: '0x0000000000000000000000000000000000000003',
    salt: `0x${'22'.repeat(32)}`,
    token: '0x20c0000000000000000000000000000000000001',
  } as const
  const signature = `0x${'ab'.repeat(65)}` as Hex
  const transaction = `0x${'cd'.repeat(32)}` as Hex

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('SessionCredentialGuards', () => {
    test('reads valid action discriminators', () => {
      expect(requireSessionCredentialAction({ action: 'open' })).toBe('open')
      expect(requireSessionCredentialAction({ action: 'topUp' })).toBe('topUp')
      expect(requireSessionCredentialAction({ action: 'voucher' })).toBe('voucher')
      expect(requireSessionCredentialAction({ action: 'close' })).toBe('close')
    })

    test('rejects non-object or unknown action payloads', () => {
      expect(() => requireSessionCredentialAction(null)).toThrow(
        'invalid session credential payload',
      )
      expect(() => requireSessionCredentialAction({ action: 'refund' })).toThrow(
        'invalid session credential action',
      )
    })

    test('requires shared channel ID header fields', () => {
      expect(requireSessionCredentialPayloadHeader({ action: 'voucher', channelId })).toEqual({
        action: 'voucher',
        channelId,
      })
      expect(
        requireSessionCredentialPayloadHeader({
          action: 'voucher',
          channelId: `0x${'AA'.repeat(32)}`,
        }),
      ).toEqual({
        action: 'voucher',
        channelId,
      })
      expect(() => requireSessionCredentialPayloadHeader({ action: 'voucher' })).toThrow(
        'invalid session credential channelId',
      )
    })

    test('normalizes and returns a typed voucher payload after action-specific validation', () => {
      expect(
        requireSessionCredentialPayload({
          action: 'voucher',
          channelId: `0x${'AA'.repeat(32)}`,
          cumulativeAmount: '1',
          descriptor,
          signature,
        }),
      ).toEqual({
        action: 'voucher',
        channelId,
        cumulativeAmount: '1',
        descriptor,
        signature,
      })
    })

    test('preserves the optional machine-token refund authorization on close', () => {
      const authorizationSignature = `0x${'ab'.repeat(65)}` as Hex
      const refundSignature = `0x${'cd'.repeat(65)}` as Hex
      expect(
        requireSessionCredentialPayload({
          action: 'close',
          authorizationSignature,
          channelId,
          cumulativeAmount: '1',
          descriptor,
          refundSignature,
          signature,
        }),
      ).toEqual({
        action: 'close',
        authorizationSignature,
        channelId,
        cumulativeAmount: '1',
        descriptor,
        refundSignature,
        signature,
      })
    })

    test('validates transaction payload fields by action', () => {
      expect(
        requireSessionCredentialPayload({
          action: 'open',
          type: 'transaction',
          channelId,
          cumulativeAmount: '1',
          descriptor,
          signature,
          transaction,
        }),
      ).toMatchObject({
        action: 'open',
        type: 'transaction',
        channelId,
        cumulativeAmount: '1',
      })
      expect(() =>
        requireSessionCredentialPayload({
          action: 'topUp',
          type: 'transaction',
          channelId,
          descriptor,
          transaction,
        }),
      ).toThrow('invalid session credential additionalDeposit')
    })

    test('rejects malformed descriptor and raw amount fields', () => {
      expect(() =>
        requireSessionCredentialPayload({
          action: 'close',
          channelId,
          cumulativeAmount: '-1',
          descriptor,
          signature,
        }),
      ).toThrow('invalid session credential cumulativeAmount')
      expect(() =>
        requireSessionCredentialPayload({
          action: 'voucher',
          channelId,
          cumulativeAmount: '1',
          descriptor: { ...descriptor, payer: 'not-an-address' },
          signature,
        }),
      ).toThrow('invalid session credential descriptor.payer')
    })

    test('rejects descriptors whose operator does not match the challenge', () => {
      const escrow = '0x4D50500000000000000000000000000000000000' as Address
      const computed = Channel.computeId({ ...descriptor, chainId: 4217, escrow })

      expect(() =>
        validateChannelDescriptor(
          descriptor,
          computed,
          4217,
          escrow,
          descriptor.payee,
          descriptor.token,
          '0x0000000000000000000000000000000000000004',
        ),
      ).toThrow('channel descriptor operator does not match server operator')
    })
  })

  describe('assertOpenCredentialCoversRequest', () => {
    test('accepts deposit and voucher amounts that cover the request', () => {
      expect(() =>
        assertOpenCredentialCoversRequest({
          cumulativeAmount: 100n,
          openDeposit: 100n,
          requestAmount: 100n,
        }),
      ).not.toThrow()
    })

    test.each([
      {
        cumulativeAmount: 100n,
        expected: 'open deposit is less than request amount',
        openDeposit: 99n,
        requestAmount: 100n,
      },
      {
        cumulativeAmount: 99n,
        expected: 'voucher amount is less than request amount',
        openDeposit: 100n,
        requestAmount: 100n,
      },
    ])('rejects insufficient open credential funding: $expected', (case_) => {
      expect(() =>
        assertOpenCredentialCoversRequest({
          cumulativeAmount: case_.cumulativeAmount,
          openDeposit: case_.openDeposit,
          requestAmount: case_.requestAmount,
        }),
      ).toThrow(case_.expected)
    })
  })

  describe('broadcastCredentialPayload', () => {
    const escrow = '0x4D50500000000000000000000000000000000000' as Address
    const testChainId = defaults.chainId.testnet
    const computedChannelId = Channel.computeId({ ...descriptor, chainId: testChainId, escrow })
    const challenge = Challenge.from({
      id: 'credential-source-test',
      realm: 'example.test',
      method: 'tempo',
      intent: 'session',
      request: {
        amount: '1',
        currency: descriptor.token,
        recipient: descriptor.payee,
        unitType: 'request',
      },
    })

    function channelStore(): ChannelStore.ChannelStore {
      return ChannelStore.fromStore(Store.memory())
    }

    async function seedChannel(store: ChannelStore.ChannelStore) {
      await store.updateChannel(computedChannelId, () => ({
        backend: 'precompile',
        authorizedSigner: descriptor.authorizedSigner,
        chainId: testChainId,
        channelId: computedChannelId,
        closeRequestedAt: 0n,
        createdAt: '2026-01-01T00:00:00.000Z',
        deposit: 100n,
        descriptor,
        escrowContract: escrow,
        expiringNonceHash: descriptor.expiringNonceHash,
        finalized: false,
        highestVoucher: null,
        highestVoucherAmount: 50n,
        operator: descriptor.operator,
        payee: descriptor.payee,
        payer: descriptor.payer,
        salt: descriptor.salt,
        settledOnChain: 0n,
        spent: 0n,
        token: descriptor.token,
        units: 0,
      }))
    }

    test('binds machine descriptors to a configured route and explicit signer', async () => {
      const deployment = defaults.machineToken[testChainId]
      const merchant = '0x0000000000000000000000000000000000000005' as Address
      const routePayee = '0x0000000000000000000000000000000000000006' as Address
      const machineDescriptor = {
        ...descriptor,
        operator: deployment.swap,
        payee: routePayee,
        token: deployment.token,
      }
      const machineChallenge = Challenge.from({
        ...challenge,
        request: {
          ...challenge.request,
          currency: defaults.tokens.usdc,
          recipient: merchant,
          methodDetails: {
            chainId: testChainId,
            escrowContract: escrow,
            machineTokenEnabled: true,
          },
        },
      })
      vi.spyOn(MachineTokenSession, 'matchRoute').mockImplementation(
        async (_client, { descriptor: candidate }) =>
          candidate.payee === routePayee
            ? { operator: deployment.swap, payee: routePayee, token: deployment.token }
            : undefined,
      )
      const parameters = (
        candidate: Channel.ChannelDescriptor,
      ): ValidateCredentialPayloadParameters => ({
        challenge: machineChallenge,
        channelStateTtl: 5_000,
        chainId: testChainId,
        client: {} as never,
        escrow,
        lastOnChainVerified: new Map(),
        minVoucherDelta: 0n,
        payload: {
          action: 'voucher',
          channelId: Channel.computeId({ ...candidate, chainId: testChainId, escrow }),
          cumulativeAmount: '1',
          descriptor: candidate,
          signature,
        },
        store: channelStore(),
      })

      await expect(validateCredentialPayload(parameters(machineDescriptor))).rejects.toThrow(
        'requires a router authorization',
      )
      await expect(broadcastCredentialPayload(parameters(machineDescriptor))).rejects.toThrow(
        'requires a router authorization',
      )
      await expect(
        validateCredentialPayload(parameters({ ...machineDescriptor, payee: descriptor.payee })),
      ).rejects.toThrow('not bound to the challenged merchant and currency')
      await expect(
        validateCredentialPayload(
          parameters({ ...machineDescriptor, authorizedSigner: zeroAddress }),
        ),
      ).rejects.toThrow('explicit authorizedSigner')

      vi.spyOn(MachineTokenSession, 'verifyAuthorization').mockReturnValue(true)
      const close = {
        ...parameters(machineDescriptor),
        challenge: Challenge.from({
          ...machineChallenge,
          request: {
            ...machineChallenge.request,
            methodDetails: { chainId: testChainId, escrowContract: escrow },
          },
        }),
        payload: {
          action: 'close' as const,
          authorizationSignature: signature,
          channelId: Channel.computeId({ ...machineDescriptor, chainId: testChainId, escrow }),
          cumulativeAmount: '1',
          descriptor: machineDescriptor,
          refundSignature: signature,
          signature,
        },
      }
      await expect(validateCredentialPayload(close)).rejects.toThrow('channel not found')
      await expect(broadcastCredentialPayload(close)).rejects.toThrow('channel not found')
    })

    test.each([
      { label: 'payer', sourceAddress: descriptor.payer },
      { label: 'authorized signer', sourceAddress: descriptor.authorizedSigner },
    ])('accepts voucher credentials from the channel $label', async ({ sourceAddress }) => {
      const store = channelStore()
      await seedChannel(store)
      const verifyVoucher = vi.spyOn(Voucher, 'verifyVoucher').mockResolvedValue(true)

      await expect(
        broadcastCredentialPayload({
          challenge,
          channelStateTtl: 60_000,
          chainId: testChainId,
          client: {} as never,
          credentialSource: `did:pkh:eip155:${testChainId}:${sourceAddress}`,
          escrow,
          lastOnChainVerified: new Map([[computedChannelId, Date.now()]]),
          minVoucherDelta: 1n,
          payload: {
            action: 'voucher',
            channelId: computedChannelId,
            cumulativeAmount: '60',
            descriptor,
            signature,
          },
          store,
        }),
      ).resolves.toMatchObject({ acceptedCumulative: '60' })
      expect(verifyVoucher).toHaveBeenCalledOnce()
    })

    test('rejects voucher credentials from a different source', async () => {
      const store = channelStore()
      await seedChannel(store)
      const verifyVoucher = vi.spyOn(Voucher, 'verifyVoucher').mockResolvedValue(true)

      await expect(
        broadcastCredentialPayload({
          challenge,
          channelStateTtl: 60_000,
          chainId: testChainId,
          client: {} as never,
          credentialSource: `did:pkh:eip155:${testChainId}:0x0000000000000000000000000000000000000099`,
          escrow,
          lastOnChainVerified: new Map([[computedChannelId, Date.now()]]),
          minVoucherDelta: 1n,
          payload: {
            action: 'voucher',
            channelId: computedChannelId,
            cumulativeAmount: '60',
            descriptor,
            signature,
          },
          store,
        }),
      ).rejects.toThrow('credential source does not match channel payer or authorized signer')
      expect(verifyVoucher).not.toHaveBeenCalled()
    })
  })
})
