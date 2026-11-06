import { DurableObject } from 'cloudflare:workers'

import { ChannelStore, channels, settle } from '../../src/cloudflare/index.js'
import { VerificationFailedError } from '../../src/Errors.js'
import * as Store from '../../src/Store.js'

type Env = {
  CHANNELS: Store.durableObject.Namespace
  LOG: Store.durableObject.Namespace
  QUEUE: ChannelStore.Queue
}

/** The channel store with short timings, bound as \`CHANNELS\`. */
export class Channels extends ChannelStore.rpc(DurableObject) {
  protected override settlement(): ChannelStore.Settlement {
    return {
      maxAttempts: 3,
      minUnsettledAmount: 100n,
      queue: (this.env as Env).QUEUE,
      retryMs: 200,
      staleAfterMs: 300,
      watchdogMs: 300,
    }
  }

  /** The object's settlement bookkeeping and alarm. */
  async status() {
    const pending = (await this.state.storage.get('mppx:channel-store:settlement')) as
      | { sends: number; settledAtSend?: bigint }
      | undefined
    return {
      alarm: (await this.state.storage.getAlarm!()) !== null,
      sends: pending?.sends ?? null,
    }
  }
}

/** Records settle calls and how the stub settles each channel, bound as \`LOG\`. */
export class Log extends Store.DurableObjectStore {}

const payee = '0x00000000000000000000000000000000000000ee'
const token = '0x20c0000000000000000000000000000000000000'
const escrowContract = '0x4d50500000000000000000000000000000000000'

type Command =
  | {
      op: 'write'
      id: string
      deposit: string
      voucher: string
      settled?: string
      finalized?: boolean
      closeRequested?: boolean
      payer: string
      transport?: 'fetch'
    }
  | { op: 'mode'; id: string; mode: 'settle' | 'drop' | 'reject' }
  | { op: 'calls'; id: string }
  | { op: 'status'; id: string }
  | { op: 'settled'; id: string }
  | { op: 'resolve'; payer: string; chainId: number }

const store = (env: Env) => channels(env.CHANNELS, { encoding: 'native', transport: 'rpc' }).store

/** Writes channels, reads their settlement status and resolves lookups inside workerd. */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const command = (await request.json()) as Command
    const log = Store.durableObject(env.LOG)
    switch (command.op) {
      case 'write': {
        const voucher = BigInt(command.voucher)
        const state = {
          authorizedSigner: command.payer,
          backend: 'precompile',
          chainId: 42431,
          channelId: command.id,
          closeRequestedAt: command.closeRequested ? 1n : 0n,
          createdAt: new Date(0).toISOString(),
          deposit: BigInt(command.deposit),
          descriptor: {},
          escrowContract,
          expiringNonceHash: '0x00',
          finalized: command.finalized ?? false,
          highestVoucher: { channelId: command.id, cumulativeAmount: voucher, signature: '0x01' },
          highestVoucherAmount: voucher,
          operator: '0x0000000000000000000000000000000000000000',
          payee,
          payer: command.payer,
          salt: '0x00',
          settledOnChain: BigInt(command.settled ?? '0'),
          spent: voucher,
          token,
          units: 1,
        }
        const target = command.transport === 'fetch' ? channels(env.CHANNELS).store : store(env)
        await target.update(command.id, () => ({ op: 'set', value: state, result: null }))
        return Response.json(null)
      }
      case 'mode':
        await log.put(`mode:${command.id}`, command.mode)
        return Response.json(null)
      case 'calls':
        return Response.json((await log.get(`calls:${command.id}`)) ?? 0)
      case 'status': {
        const object = env.CHANNELS.get(env.CHANNELS.idFromName(command.id)) as unknown as Channels
        return Response.json(await object.status())
      }
      case 'settled': {
        const state = (await store(env).get(command.id)) as { settledOnChain: bigint } | null
        return Response.json(state ? String(state.settledOnChain) : null)
      }
      case 'resolve': {
        const { resolveChannelId } = channels(env.CHANNELS, {
          encoding: 'native',
          transport: 'rpc',
        })
        const channelId = await resolveChannelId({
          credential: null,
          paymentRequest: {
            amount: '1',
            currency: token,
            decimals: 6,
            recipient: payee,
            unitType: 'request',
          },
          source: `did:pkh:eip155:${command.chainId}:${command.payer}`,
          store: undefined as never,
        })
        return Response.json(channelId ?? null)
      }
    }
  },

  /** Settles queued channels with a stub that records each call instead of a transaction. */
  async queue(batch: settle.Batch, env: Env): Promise<void> {
    const log = Store.durableObject(env.LOG)
    await settle(batch, {
      getClient: () => ({}) as never,
      store: store(env),
      async settle(channels, _client, channelId) {
        await log.update(`calls:${channelId}`, (calls) => {
          const next = ((calls as number | null) ?? 0) + 1
          return { op: 'set', value: next, result: next }
        })
        const mode = await log.get(`mode:${channelId}`)
        if (mode === 'reject') throw new VerificationFailedError({ reason: 'no voucher to settle' })
        if (mode === 'settle')
          await (channels as Store.AtomicStore).update(channelId, (current) => {
            const state = current as { highestVoucherAmount: bigint }
            return {
              op: 'set',
              value: { ...state, settledOnChain: state.highestVoucherAmount },
              result: null,
            }
          })
        return '0x1234'
      },
    })
  },
}
