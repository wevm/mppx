import { Receipt } from 'mppx'
import { Mppx as Mppx_client, session as sessionIntent } from 'mppx/client'
import { Mppx as Mppx_server, tempo as tempo_server } from 'mppx/server'
import { Hex } from 'ox'
import { zeroAddress } from 'viem'
import { readContract, sendRawTransaction, waitForTransactionReceipt } from 'viem/actions'
import { Abis, Actions } from 'viem/tempo'
import { beforeAll, describe, expect, test } from 'vp/test'
import { tempoNetworkConfig } from '~test/config.js'
import { accounts, asset, chain, client, fundAccount } from '~test/tempo/viem.js'

import * as Store from '../../../Store.js'
import { createClosePayload, createOpenPayload } from '../client/ChannelOps.js'
import { getChannelState } from '../precompile/Chain.js'
import { tip20ChannelEscrow, uint96 } from '../precompile/Protocol.js'
import * as ChannelStore from './ChannelStore.js'
import { settle } from './Session.js'

const isPrecompileTestnet = tempoNetworkConfig.enabled
const issuer = accounts[0]
const merchant = accounts[3]
const payer = accounts[4]
const secretKey = 'test-secret-key-test-secret-key-32'

// MACH reaches only whitelisted recipients and cannot pay fees. A localnet token with a TIP-403
// whitelist of the payer, the merchant and the channel escrow behaves the same way: the fee
// manager cannot receive it, so its sessions must pay gas in another token.
let restricted: Hex.Hex

describe.runIf(isPrecompileTestnet)(
  'session in a fee-incapable, recipient-restricted token',
  () => {
    beforeAll(async () => {
      await fundAccount({ address: payer.address, token: asset })
      await fundAccount({ address: merchant.address, token: asset })
      const created = await Actions.token.createSync(client, {
        account: issuer,
        chain,
        currency: 'USD',
        name: 'Machine Test',
        symbol: 'MACHT',
      })
      restricted = created.token
      await Actions.token.grantRolesSync(client, {
        account: issuer,
        chain,
        roles: ['issuer'],
        to: issuer.address,
        token: restricted,
      })
      await Actions.token.mintSync(client, {
        account: issuer,
        amount: 10_000_000n,
        chain,
        to: payer.address,
        token: restricted,
      })
      const { policyId } = await Actions.policy.createSync(client, {
        account: issuer,
        addresses: [payer.address, merchant.address, tip20ChannelEscrow],
        chain,
        type: 'whitelist',
      })
      await Actions.token.changeTransferPolicySync(client, {
        account: issuer,
        chain,
        policyId,
        token: restricted,
      })
    })

    test('rejects the token as a fee token', async () => {
      const open = await createOpenPayload(client, payer, {
        chainId: chain.id,
        deposit: uint96(1_000_000n),
        initialAmount: uint96(100_000n),
        payee: merchant.address,
        token: restricted,
      })
      if (open.action !== 'open') throw new Error('expected open payload')
      const error = await sendRawTransaction(client, {
        serializedTransaction: open.transaction as never,
      }).catch((error: Error) => error)
      expect(String(error)).toMatch(/FeeAMM/)
    })

    test('opens, pays, settles and closes a direct channel with gas in the advertised fee token', async () => {
      const rawStore = Store.memory()
      const store = ChannelStore.fromStore(rawStore)
      const methods = tempo_server.session({
        account: merchant,
        chainId: chain.id,
        currencies: [restricted],
        feeToken: asset,
        getClient: () => client,
        store: rawStore,
      })
      const server = Mppx_server.create({ methods: [methods], secretKey })
      const route = server.session({ amount: '0.1', unitType: 'request' })
      const handle = async (request: Request) => {
        const result = await route(request)
        if (result.status === 402) return result.challenge
        return result.withReceipt(Response.json({ ok: true }))
      }

      const challengeResponse = await handle(new Request('https://merchant.example/paid'))
      expect(challengeResponse.status).toBe(402)

      const { fetch } = Mppx_client.create({
        fetch: (input, init) => handle(new Request(input, init)),
        methods: [sessionIntent({ account: payer, getClient: () => client, maxDeposit: '1' })],
        polyfill: false,
      })
      const before = await balanceOf(payer.address)
      let channelId: Hex.Hex | undefined
      for (let i = 0; i < 3; i++) {
        const response = await fetch('https://merchant.example/paid')
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ ok: true })
        channelId = Receipt.fromResponse(response).reference as Hex.Hex
      }

      const channel = await store.getChannel(channelId!)
      if (!channel || !ChannelStore.isPrecompileState(channel))
        throw new Error('expected a stored precompile channel')
      expect(channel.token.toLowerCase()).toBe(restricted.toLowerCase())
      expect(channel.payee.toLowerCase()).toBe(merchant.address.toLowerCase())
      expect(channel.operator).toBe(zeroAddress)
      expect(channel.spent).toBe(300_000n)
      // The payer's open paid gas in the advertised fee token, so only the deposit left in MACH.
      const afterOpen = await balanceOf(payer.address)
      expect(before - afterOpen).toBe(channel.deposit)

      const settleHash = await settle(store, client, channel.channelId, {
        account: merchant,
        feeToken: asset,
      })
      expect((await waitForTransactionReceipt(client, { hash: settleHash })).status).toBe('success')
      expect((await getChannelState(client, channel.channelId, tip20ChannelEscrow)).settled).toBe(
        300_000n,
      )
      expect(await balanceOf(merchant.address)).toBe(300_000n)

      const close = await createClosePayload(
        client,
        payer,
        channel.descriptor,
        uint96(300_000n),
        chain.id,
      )
      const closed = await methods[0].verify({
        credential: {
          challenge: {
            id: 'close',
            realm: 'merchant.example',
            method: 'tempo',
            intent: 'session',
            request: closeRequest(channel.channelId),
          } as never,
          payload: close,
        },
        request: closeRequest(channel.channelId) as never,
      })
      if (!('txHash' in closed)) throw new Error('expected close txHash')
      expect(
        (await waitForTransactionReceipt(client, { hash: closed.txHash as Hex.Hex })).status,
      ).toBe('success')
      expect((await store.getChannel(channel.channelId))?.finalized).toBe(true)
      // The unspent deposit returns to the payer.
      expect(await balanceOf(payer.address)).toBe(before - 300_000n)
    })
  },
)

function balanceOf(account: Hex.Hex) {
  return readContract(client, {
    abi: Abis.tip20,
    address: restricted,
    args: [account],
    functionName: 'balanceOf',
  })
}

function closeRequest(channelId: Hex.Hex) {
  return {
    amount: '100000',
    currency: restricted,
    recipient: merchant.address,
    unitType: 'request',
    methodDetails: {
      chainId: chain.id,
      channelId,
      escrowContract: tip20ChannelEscrow,
      feeToken: asset,
    },
  }
}
