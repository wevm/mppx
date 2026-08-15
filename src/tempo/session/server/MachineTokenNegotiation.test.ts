import {
  type Address,
  createClient,
  custom,
  encodeAbiParameters,
  encodeFunctionData,
  zeroAddress,
} from 'viem'
import { describe, expect, test } from 'vp/test'

import * as Constants from '../../../Constants.js'
import * as defaults from '../../internal/defaults.js'
import * as Methods from '../../Methods.js'
import * as Channel from '../precompile/Channel.js'
import { tip20ChannelEscrow } from '../precompile/Protocol.js'
import { resolveCredentialChallenge } from './CredentialVerification.js'
import { session } from './Session.js'

const chainId = defaults.chainId.testnet
const deployment = defaults.machineToken[chainId]
const merchant = '0x2222222222222222222222222222222222222222' as Address
const otherMerchant = '0x3333333333333333333333333333333333333333' as Address
const payer = '0x1111111111111111111111111111111111111111' as Address
const targetToken = '0x20C0000000000000000000000000000000000001' as Address
const routeAddress = '0x44D7c1EDFdfdfDFdFdFDFDFd0000000000000001' as Address

const routeAbi = [
  {
    inputs: [
      { name: 'merchant', type: 'address' },
      { name: 'targetToken', type: 'address' },
    ],
    name: 'sessionRouteFor',
    outputs: [{ name: 'routeAddress', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ name: 'routeAddress', type: 'address' }],
    name: 'sessionRoutes',
    outputs: [
      { name: 'merchant', type: 'address' },
      { name: 'targetToken', type: 'address' },
    ],
    stateMutability: 'view',
    type: 'function',
  },
] as const

function routeClient(active = true) {
  const sessionRouteForSelector = encodeFunctionData({
    abi: routeAbi,
    functionName: 'sessionRouteFor',
    args: [merchant, targetToken],
  }).slice(0, 10)
  const sessionRoutesSelector = encodeFunctionData({
    abi: routeAbi,
    functionName: 'sessionRoutes',
    args: [routeAddress],
  }).slice(0, 10)

  return createClient({
    chain: { id: chainId } as never,
    transport: custom({
      async request(args) {
        if (args.method === 'eth_chainId') return `0x${chainId.toString(16)}`
        if (args.method === 'eth_call') {
          const data = (args.params as [{ data?: `0x${string}` }])[0].data
          if (data?.slice(0, 10) === sessionRouteForSelector)
            return encodeAbiParameters([{ type: 'address' }], [active ? routeAddress : zeroAddress])
          if (data?.slice(0, 10) === sessionRoutesSelector)
            return encodeAbiParameters(
              [{ type: 'address' }, { type: 'address' }],
              [merchant, targetToken],
            )
        }
        throw new Error(`unexpected RPC request: ${args.method}`)
      },
    }),
  })
}

function logicalRequest() {
  return {
    amount: '1',
    chainId,
    currency: targetToken,
    decimals: 6,
    machineTokenEnabled: true,
    recipient: merchant,
    unitType: 'request' as const,
  }
}

function challenge(recipient: Address = merchant, machineTokenEnabled = true) {
  return {
    id: 'machine-session-challenge',
    intent: 'session',
    method: 'tempo',
    realm: 'merchant.example',
    request: {
      amount: '1000000',
      currency: targetToken,
      methodDetails: {
        chainId,
        escrowContract: tip20ChannelEscrow,
        machineTokenEnabled,
        sessionProtocol: Constants.SessionProtocols.v2,
      },
      recipient,
      unitType: 'request',
    },
  } as const
}

const descriptor = {
  authorizedSigner: payer,
  expiringNonceHash: `0x${'22'.repeat(32)}` as const,
  operator: deployment.swap,
  payee: routeAddress,
  payer,
  salt: `0x${'11'.repeat(32)}` as const,
  token: deployment.token,
}
const channelId = Channel.computeId({
  ...descriptor,
  chainId,
  escrow: tip20ChannelEscrow,
})

describe('machine-token session negotiation', () => {
  test('keeps the server request logical and binds the capability into method details', async () => {
    const method = session({
      amount: '1',
      chainId,
      currency: targetToken,
      getClient: () => routeClient(),
      machineTokenEnabled: true,
      recipient: merchant,
      unitType: 'request',
    })

    const request = await method.request!({ credential: null, request: logicalRequest() } as never)
    expect(request).toMatchObject({
      currency: targetToken,
      machineTokenEnabled: true,
      recipient: merchant,
    })
    expect(Methods.session.schema.request.parse(request)).toMatchObject({
      currency: targetToken,
      methodDetails: { chainId, machineTokenEnabled: true },
      recipient: merchant,
    })
  })

  test('accepts only the canonical route for the challenged merchant and currency', async () => {
    await expect(
      resolveCredentialChallenge({
        challenge: challenge(),
        chainId,
        client: routeClient(),
        escrow: tip20ChannelEscrow,
        payload: {
          action: 'voucher',
          channelId,
          cumulativeAmount: '1',
          descriptor,
          signature: '0x',
        },
      }),
    ).resolves.toMatchObject({
      challenge: { request: { currency: deployment.token, recipient: routeAddress } },
      expectedOperator: deployment.swap,
    })

    await expect(
      resolveCredentialChallenge({
        challenge: challenge(otherMerchant),
        chainId,
        client: routeClient(),
        escrow: tip20ChannelEscrow,
        payload: {
          action: 'voucher',
          channelId,
          cumulativeAmount: '1',
          descriptor,
          signature: '0x',
        },
      }),
    ).rejects.toThrow('not bound to the challenged merchant and currency')
    await expect(
      resolveCredentialChallenge({
        challenge: challenge(merchant, false),
        chainId,
        client: routeClient(),
        escrow: tip20ChannelEscrow,
        payload: {
          action: 'voucher',
          channelId,
          cumulativeAmount: '1',
          descriptor,
          signature: '0x',
        },
      }),
    ).rejects.toThrow('payee does not match server destination')
  })

  test('requires an active route for payments but permits an immutable route during close', async () => {
    await expect(
      resolveCredentialChallenge({
        challenge: challenge(),
        chainId,
        client: routeClient(false),
        escrow: tip20ChannelEscrow,
        payload: {
          action: 'voucher',
          channelId,
          cumulativeAmount: '1',
          descriptor,
          signature: '0x',
        },
      }),
    ).rejects.toThrow('not bound to the challenged merchant and currency')
    await expect(
      resolveCredentialChallenge({
        challenge: challenge(),
        chainId,
        client: routeClient(false),
        escrow: tip20ChannelEscrow,
        payload: { action: 'close', channelId, cumulativeAmount: '1', descriptor, signature: '0x' },
      }),
    ).resolves.toMatchObject({
      challenge: { request: { recipient: routeAddress } },
      expectedOperator: deployment.swap,
    })
  })
})
