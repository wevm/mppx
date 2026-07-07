import type { Address, Hex } from 'viem'
import { afterEach, describe, expect, test, vi } from 'vp/test'

import * as Challenge from '../../../Challenge.js'
import * as Store from '../../../Store.js'
import { chainId as chainIds } from '../../internal/defaults.js'
import * as Channel from '../precompile/Channel.js'
import * as Voucher from '../precompile/Voucher.js'
import * as ChannelStore from './ChannelStore.js'
import {
  assertOpenCredentialCoversRequest,
  requireSessionCredentialAction,
  requireSessionCredentialPayload,
  requireSessionCredentialPayloadHeader,
  validateChannelDescriptor,
  verifyCredentialPayload,
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

  describe('verifyCredentialPayload', () => {
    const escrow = '0x4D50500000000000000000000000000000000000' as Address
    const testChainId = chainIds.testnet
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

    test.each([
      { label: 'payer', sourceAddress: descriptor.payer },
      { label: 'authorized signer', sourceAddress: descriptor.authorizedSigner },
    ])('accepts voucher credentials from the channel $label', async ({ sourceAddress }) => {
      const store = channelStore()
      await seedChannel(store)
      const verifyVoucher = vi.spyOn(Voucher, 'verifyVoucher').mockResolvedValue(true)

      await expect(
        verifyCredentialPayload({
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
        verifyCredentialPayload({
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
