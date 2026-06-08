import type { Address, Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { describe, expect, test } from 'vp/test'

import type * as Credential from '../../../Credential.js'
import type { SessionCredentialPayload } from '../precompile/Protocol.js'
import type * as ChannelStore from './ChannelStore.js'
import {
  requireSessionCredentialAction,
  requireSessionCredentialPayloadHeader,
} from './CredentialVerification.js'
import {
  getChallengePaymentFields,
  getCredentialChannelId,
  normalizeSessionChannelId,
  respondToSessionCredential,
  resolveCredentialVerificationContext,
  resolveSessionChannelId,
  resolveSessionPaymentRequest,
  resolveSessionSnapshot,
  resolveVerificationRequest,
} from './RequestState.js'

describe('RequestContext', () => {
  const channelId = `0x${'aa'.repeat(32)}` as Hex
  const escrowContract = '0x4D50500000000000000000000000000000000000' as Address
  const feePayer = privateKeyToAccount(
    '0x59c6995e998f97a5a0044966f0945383c7ac45c5a0642d5c9fa4f071979ab3c1',
  )

  describe('precompile session request context', () => {
    test('reads action without requiring channel context', () => {
      expect(requireSessionCredentialAction({ action: 'close' })).toBe('close')
      expect(requireSessionCredentialAction({ action: 'topUp' })).toBe('topUp')
    })

    test('rejects missing or unknown actions', () => {
      expect(() => requireSessionCredentialAction(null)).toThrow(
        'invalid session credential payload',
      )
      expect(() => requireSessionCredentialAction({ action: 'refund' })).toThrow(
        'invalid session credential action',
      )
    })

    test('reads action and channel ID for verification payloads', () => {
      expect(requireSessionCredentialPayloadHeader({ action: 'voucher', channelId })).toEqual({
        action: 'voucher',
        channelId,
      })
    })

    test('rejects verification payload headers without channel ID', () => {
      expect(() => requireSessionCredentialPayloadHeader({ action: 'voucher' })).toThrow(
        'invalid session credential channelId',
      )
    })

    test('normalizes credential channel IDs for bootstrap hints', () => {
      const mixedCase = `0x${'AA'.repeat(32)}` as Hex
      const credential = {
        challenge: {},
        payload: { channelId: mixedCase },
      } as Credential.Credential

      expect(getCredentialChannelId(credential)).toBe(channelId)
      expect(getCredentialChannelId(null)).toBeUndefined()
      expect(
        getCredentialChannelId({ challenge: {}, payload: {} } as Credential.Credential),
      ).toBeUndefined()
    })

    test('reads typed challenge payment fields', () => {
      expect(
        getChallengePaymentFields({
          id: 'challenge-id',
          realm: 'test',
          method: 'tempo',
          intent: 'session',
          request: {
            amount: '123',
            currency: escrowContract,
            recipient: feePayer.address,
          },
        }),
      ).toEqual({
        amount: 123n,
        currency: escrowContract,
        recipient: feePayer.address,
      })
    })

    test('rejects challenge payment fields with missing destination', () => {
      expect(() =>
        getChallengePaymentFields({
          id: 'challenge-id',
          realm: 'test',
          method: 'tempo',
          intent: 'session',
          request: {
            amount: '123',
            currency: escrowContract,
          },
        }),
      ).toThrow('missing challenge recipient')
    })

    test('rejects challenge payment fields with invalid token addresses', () => {
      expect(() =>
        getChallengePaymentFields({
          id: 'challenge-id',
          realm: 'test',
          method: 'tempo',
          intent: 'session',
          request: {
            amount: '123',
            currency: 'pathUSD',
            recipient: feePayer.address,
          },
        }),
      ).toThrow('missing challenge currency')
    })

    test('rejects invalid request escrow contracts before challenge creation', async () => {
      await expect(
        resolveSessionPaymentRequest({
          credential: null,
          decimals: 2,
          getClient: async () => ({ chain: { id: 42431 } }),
          request: {
            amount: '1',
            chainId: 42431,
            currency: escrowContract,
            decimals: 2,
            escrowContract: 'not-an-address' as Address,
            recipient: feePayer.address,
            unitType: 'request',
          },
          store: {
            async getChannel() {
              return null
            },
            async updateChannel() {
              return null
            },
          },
        }),
      ).rejects.toThrow('Invalid escrowContract configured for tempo.session().')
    })

    test('resolves verification context from canonical method details', async () => {
      const client = { chain: { id: 42431 } } as never
      const context = await resolveCredentialVerificationContext({
        decimals: 2,
        feePayer,
        getClient: async () => client,
        minVoucherDelta: '1.25',
        request: {
          amount: '100',
          currency: 'pathUSD',
          methodDetails: {
            chainId: 42431,
            escrowContract,
            feePayer: true,
          },
          unitType: 'request',
        },
      })

      expect(context).toMatchObject({
        chainId: 42431,
        client,
        escrow: escrowContract,
        feePayer,
        minVoucherDelta: 125n,
      })
    })

    test('uses challenge minVoucherDelta before server default', async () => {
      const context = await resolveCredentialVerificationContext({
        decimals: 2,
        getClient: async () => ({}) as never,
        minVoucherDelta: '1.25',
        request: {
          amount: '100',
          currency: 'pathUSD',
          methodDetails: {
            chainId: 42431,
            escrowContract,
            minVoucherDelta: '7',
          },
          unitType: 'request',
        },
      })

      expect(context.minVoucherDelta).toBe(7n)
    })

    test('accepts already canonical challenge requests after schema parse fallback', () => {
      const request = {
        amount: '100',
        currency: 'pathUSD',
        methodDetails: {
          chainId: 42431,
          escrowContract,
        },
        unitType: 'request',
      }

      expect(resolveVerificationRequest(request)).toBe(request)
    })

    test('rejects invalid canonical fallback requests', () => {
      expect(() =>
        resolveVerificationRequest({
          amount: '100',
          methodDetails: {
            chainId: 42431,
            escrowContract,
          },
        }),
      ).toThrow('invalid session request')
    })

    test('rejects canonical fallback requests with invalid escrow contracts', () => {
      expect(() =>
        resolveVerificationRequest({
          amount: '100',
          currency: escrowContract,
          methodDetails: {
            chainId: 42431,
            escrowContract: 'not-an-address',
          },
          unitType: 'request',
        }),
      ).toThrow('invalid session request')
    })
  })
})

describe('ResponseGate', () => {
  function respond(action: SessionCredentialPayload['action'], input: Request) {
    return respondToSessionCredential({
      input,
      payload: { action },
    })
  }

  describe('ResponseGate', () => {
    test('returns 204 for close and top-up management actions', () => {
      expect(respond('close', new Request('http://localhost', { method: 'GET' }))?.status).toBe(204)
      expect(respond('topUp', new Request('http://localhost', { method: 'POST' }))?.status).toBe(
        204,
      )
    })

    test('returns 204 for empty open and voucher POST management actions', () => {
      expect(respond('open', new Request('http://localhost', { method: 'POST' }))?.status).toBe(204)
      expect(respond('voucher', new Request('http://localhost', { method: 'POST' }))?.status).toBe(
        204,
      )
    })

    test('lets open and voucher content requests through', () => {
      expect(respond('open', new Request('http://localhost', { method: 'GET' }))).toBeUndefined()
      expect(
        respond(
          'voucher',
          new Request('http://localhost', {
            method: 'POST',
            headers: { 'content-length': '1' },
          }),
        ),
      ).toBeUndefined()
    })

    test('uses captured request metadata when supplied', () => {
      expect(
        respondToSessionCredential({
          input: new Request('http://localhost', { method: 'POST' }),
          payload: { action: 'voucher' },
          capturedRequest: {
            headers: new Headers({ 'content-length': '1' }),
            hasBody: false,
            method: 'POST',
          },
        }),
      ).toBeUndefined()
    })
  })
})

describe('SessionSnapshotHints', () => {
  const channelId = `0x${'aa'.repeat(32)}` as Hex
  const escrowContract = '0x4D50500000000000000000000000000000000000' as Address
  const descriptor = {
    authorizedSigner: '0x0000000000000000000000000000000000000001',
    expiringNonceHash: `0x${'11'.repeat(32)}`,
    operator: '0x0000000000000000000000000000000000000000',
    payee: '0x0000000000000000000000000000000000000002',
    payer: '0x0000000000000000000000000000000000000003',
    salt: `0x${'22'.repeat(32)}`,
    token: '0x20c0000000000000000000000000000000000001',
  } as const

  function channel(overrides: Partial<ChannelStore.State> = {}): ChannelStore.State {
    return {
      authorizedSigner: descriptor.authorizedSigner,
      backend: 'precompile',
      chainId: 4217,
      channelId,
      closeRequestedAt: 0n,
      createdAt: new Date(0).toISOString(),
      deposit: 1_000n,
      descriptor,
      escrowContract,
      expiringNonceHash: descriptor.expiringNonceHash,
      finalized: false,
      highestVoucher: null,
      highestVoucherAmount: 500n,
      operator: descriptor.operator,
      payee: descriptor.payee,
      payer: descriptor.payer,
      salt: descriptor.salt,
      settledOnChain: 100n,
      spent: 300n,
      token: descriptor.token,
      units: 3,
      ...overrides,
    }
  }

  function store(state: ChannelStore.State | null): ChannelStore.ChannelStore {
    return {
      async getChannel() {
        return state
      },
      async updateChannel() {
        throw new Error('unexpected update')
      },
    }
  }

  describe('SessionSnapshotHints', () => {
    test('normalizes optional channel ID hints', () => {
      expect(normalizeSessionChannelId(`0x${'AA'.repeat(32)}`)).toBe(channelId)
      expect(normalizeSessionChannelId(undefined)).toBeUndefined()
      expect(normalizeSessionChannelId(123)).toBeUndefined()
      expect(normalizeSessionChannelId('0x1234')).toBeUndefined()
      expect(normalizeSessionChannelId(`0x${'zz'.repeat(32)}`)).toBeUndefined()
    })

    test('resolves bootstrap channel IDs from explicit hints before custom resolver', async () => {
      let called = false
      const resolved = await resolveSessionChannelId({
        credential: {
          challenge: {},
          payload: { channelId: `0x${'AA'.repeat(32)}` },
        } as Credential.Credential,
        request: {
          amount: '1',
          currency: descriptor.token,
          decimals: 0,
          recipient: descriptor.payee,
          unitType: 'request',
        },
        resolveChannelId() {
          called = true
          return `0x${'bb'.repeat(32)}`
        },
        store: store(null),
      })

      expect(resolved).toBe(channelId)
      expect(called).toBe(false)
    })

    test('uses custom resolver when no explicit channel ID is present', async () => {
      const resolved = await resolveSessionChannelId({
        capturedRequest: {
          headers: new Headers({ cookie: 'sid=abc' }),
          method: 'GET',
          url: new URL('https://api.example.com/resource'),
        },
        credential: null,
        request: {
          amount: '1',
          currency: descriptor.token,
          decimals: 0,
          recipient: descriptor.payee,
          unitType: 'request',
        },
        resolveChannelId({ request, paymentRequest }) {
          expect(request?.headers.get('cookie')).toBe('sid=abc')
          expect(paymentRequest.unitType).toBe('request')
          return `0x${'AA'.repeat(32)}`
        },
        store: store(null),
      })

      expect(resolved).toBe(channelId)
    })

    test('rejects invalid channel IDs returned by custom resolver', async () => {
      await expect(
        resolveSessionChannelId({
          credential: null,
          request: {
            amount: '1',
            currency: descriptor.token,
            decimals: 0,
            recipient: descriptor.payee,
            unitType: 'request',
          },
          resolveChannelId: () => '0x1234',
          store: store(null),
        }),
      ).rejects.toThrow('Invalid session channel ID.')
    })

    test('builds reusable channel hints without lowering accepted cumulative', async () => {
      await expect(
        resolveSessionSnapshot({ amount: 50n, channelId, store: store(channel()) }),
      ).resolves.toEqual({
        acceptedCumulative: '500',
        chainId: 4217,
        channelId,
        closeRequestedAt: undefined,
        deposit: '1000',
        descriptor,
        escrow: escrowContract,
        requiredCumulative: '350',
        settled: '100',
        spent: '300',
        units: 3,
      })
    })

    test('raises accepted cumulative when next request exceeds current authorization', async () => {
      const snapshot = await resolveSessionSnapshot({
        amount: 300n,
        channelId,
        store: store(channel()),
      })

      expect(snapshot?.requiredCumulative).toBe('600')
      expect(snapshot?.acceptedCumulative).toBe('600')
    })

    test('omits hints for missing, non-precompile, or finalized channels', async () => {
      await expect(
        resolveSessionSnapshot({ amount: 1n, channelId, store: store(null) }),
      ).resolves.toBe(undefined)
      await expect(
        resolveSessionSnapshot({
          amount: 1n,
          channelId,
          store: store(channel({ backend: 'external' } as Partial<ChannelStore.State>)),
        }),
      ).resolves.toBe(undefined)
      await expect(
        resolveSessionSnapshot({
          amount: 1n,
          channelId,
          store: store(channel({ finalized: true })),
        }),
      ).resolves.toBe(undefined)
    })
  })
})
