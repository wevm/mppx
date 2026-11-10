import { Challenge, Credential } from 'mppx'
import { Mppx, Store, tempo } from 'mppx/server'
import {
  createClient,
  custom,
  decodeFunctionData,
  encodeAbiParameters,
  keccak256,
  maxUint256,
  type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { signTransaction } from 'viem/actions'
import { Abis } from 'viem/tempo'
import { tempo as tempoChain } from 'viem/tempo/chains'
import { expect, test } from 'vp/test'

import * as Attribution from '../Attribution.js'
import * as defaults from '../internal/defaults.js'
import * as MachineTokenCharge from '../internal/machine-token-charge.js'

const chainId = defaults.chainId.mainnet
const merchant = privateKeyToAccount(
  '0x0000000000000000000000000000000000000000000000000000000000000001',
)
const payer = privateKeyToAccount(
  '0x0000000000000000000000000000000000000000000000000000000000000002',
)
const realm = 'api.example.com'
const secretKey = 'test-secret-key-that-is-at-least-32-bytes'

test.each([
  { machineTokenBalance: 250_000n, fundingUrl: true, replayed: false },
  { machineTokenBalance: 2_000_000n, fundingUrl: false, replayed: false },
  { machineTokenBalance: 250_000n, fundingUrl: false, replayed: 'store' },
  { machineTokenBalance: 250_000n, fundingUrl: false, replayed: 'chain' },
])(
  'links a pull MACH payment that fails simulation to the MACH onramp (balance $machineTokenBalance, replayed $replayed)',
  async ({ machineTokenBalance, fundingUrl, replayed }) => {
    const store = Store.memory()
    const client = createClient({
      account: payer,
      chain: { ...tempoChain, id: chainId },
      transport: custom(
        {
          async request({ method, params }) {
            if (method === 'eth_chainId') return `0x${chainId.toString(16)}`
            if (method === 'eth_getTransactionReceipt')
              return replayed === 'chain'
                ? {
                    blockHash: `0x${'11'.repeat(32)}`,
                    blockNumber: '0x1',
                    contractAddress: null,
                    cumulativeGasUsed: '0x5208',
                    effectiveGasPrice: '0x3b9aca00',
                    from: payer.address,
                    gasUsed: '0x5208',
                    logs: [],
                    logsBloom: `0x${'00'.repeat(256)}`,
                    status: '0x1',
                    to: null,
                    transactionHash: (params as [Hex])[0],
                    transactionIndex: '0x0',
                    type: '0x76',
                  }
                : null
            if (method === 'eth_call') {
              const data = (params as [{ data?: Hex; input?: Hex }])[0]
              const input = data.data ?? data.input
              if (input) {
                try {
                  const decoded = decodeFunctionData({ abi: Abis.tip20, data: input })
                  if (decoded.functionName === 'balanceOf')
                    return encodeAbiParameters([{ type: 'uint256' }], [machineTokenBalance])
                } catch {}
              }
              throw new Error('execution reverted')
            }
            throw new Error(`Unexpected RPC method: ${method}`)
          },
        },
        { retryCount: 0 },
      ),
    })
    const mppx = Mppx.create({
      methods: [
        tempo.charge({
          account: merchant,
          currency: defaults.tokens.usdc,
          getClient: () => client,
          machineTokenEnabled: true,
          store,
          supportedModes: ['pull'],
        }),
      ],
      realm,
      secretKey,
    })

    const challengeResponse = await mppx.charge({ amount: '1.5', decimals: 6 })(
      new Request('https://api.example.com/resource'),
    )
    expect(challengeResponse.status).toBe(402)
    if (challengeResponse.status !== 402) throw new Error('expected a challenge')
    const challenge = Challenge.fromResponse(challengeResponse.challenge)
    const calls = MachineTokenCharge.getRoute({
      chainId,
      currency: defaults.tokens.usdc,
      transfers: [
        {
          amount: 1_500_000n,
          memo: Attribution.encode({ challengeId: challenge.id, serverId: challenge.realm }),
          recipient: merchant.address,
        },
      ],
    })!.calls
    const signature = await signTransaction(client, {
      account: payer,
      calls,
      feeToken: defaults.tokens.usdc,
      gas: 100_000n,
      maxFeePerGas: 1_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
      nonce: 0,
      nonceKey: maxUint256,
      validBefore: Math.floor(Date.now() / 1_000) + 25,
    } as never)
    const credential = Credential.serialize({
      challenge,
      payload: { signature, type: 'transaction' },
      source: `did:pkh:eip155:${chainId}:${payer.address}`,
    })

    // A transaction that already settled holds its replay marker when it is sent again.
    if (replayed === 'store')
      await Store.tryClaim(
        store,
        `mppx:charge:${keccak256(signature).toLowerCase()}`,
        Date.now() + 60_000,
      )

    const response = await mppx.charge({ amount: '1.5', decimals: 6 })(
      new Request('https://api.example.com/resource', {
        headers: { Authorization: credential },
      }),
    )
    expect(response.status).toBe(402)
    if (response.status !== 402) throw new Error('expected a rejection')
    const problem = (await response.challenge.json()) as Record<string, unknown>
    if (replayed) {
      expect(response.challenge.status).toBe(403)
      expect(problem.detail).toContain('Transaction hash has already been used')
      expect(problem).not.toHaveProperty('fundingUrl')
    } else if (fundingUrl) {
      expect(response.challenge.status).toBe(402)
      expect(problem.type).toBe('https://paymentauth.org/problems/verification-failed')
      expect(problem.fundingUrl).toBe(
        `${defaults.machineTokenFundingBaseUrl}&address=${payer.address}&amount=1.25`,
      )
      expect(problem.detail).toContain('requested 1.5 MACH, available 0.25 MACH')
      expect(problem.detail).toContain(problem.fundingUrl as string)
    } else {
      expect(response.challenge.status).toBe(500)
      expect(problem).not.toHaveProperty('fundingUrl')
    }
  },
)
