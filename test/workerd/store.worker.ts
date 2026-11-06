import { DurableObject } from 'cloudflare:workers'

import * as Store from '../../src/Store.js'

/** The store's Durable Object class, bound as `STORE`. */
export class MppxStore extends Store.DurableObjectStore {}

/** Records every write and the alarms it schedules, bound as `RECORDING`. */
export class RecordingStore extends Store.DurableObjectStore {
  protected override async onWrite(key: string, previous: unknown, next: unknown) {
    const writes = JSON.parse(((await this.storage.get('__writes')) as string | undefined) ?? '[]')
    writes.push({ key, previous, next })
    await this.storage.put('__writes', JSON.stringify(writes))
    await this.storage.setAlarm!(Date.now() + 10)
  }

  override async alarm() {
    const alarms = Number((await this.storage.get('__alarms')) ?? 0)
    await this.storage.put('__alarms', String(alarms + 1))
  }

  override async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname !== '/log') return super.fetch(request)
    return Response.json({
      alarms: Number((await this.storage.get('__alarms')) ?? 0),
      writes: JSON.parse(((await this.storage.get('__writes')) as string | undefined) ?? '[]'),
    })
  }
}

/** The store over Workers RPC, bound as `RPC_STORE`. */
export class RpcStore extends Store.DurableObjectStore.rpc(DurableObject) {
  /** Writes a value as a plain Durable Object does, with `ctx.storage.put`. */
  async legacyPut(key: string, value: unknown) {
    await this.state.storage.put(key, value)
  }

  /** Reads a value as a plain Durable Object does. */
  async legacyGet(key: string) {
    return this.state.storage.get(key)
  }
}

/** The store over Workers RPC with native encoding, bound as `NATIVE_STORE`. */
export class NativeStore extends RpcStore {}

/** A channel's state as a Durable Object stores it, with bigints. */
type Channel = {
  channelId: string
  closed: boolean
  deposit: bigint
  spent: bigint
  vouchers: { nonce: bigint }[]
}

type Env = {
  NATIVE_STORE: Store.durableObject.Namespace
  RPC_STORE: Store.durableObject.Namespace
  DB: Store.d1.Database
  RECORDING: Store.durableObject.Namespace
  STORE: Store.durableObject.Namespace
}

type Command = { backend?: 'd1' | 'durableObject' | 'native' | 'recording' | 'rpc' } & (
  | { op: 'get' | 'delete'; key: string; prefix?: string }
  | { op: 'put'; key: string; value: unknown; prefix?: string }
  | { op: 'increment'; key: string }
  | { op: 'bigint'; key: string; amount: string }
  | { op: 'claim'; key: string; expires: number }
  | { op: 'raw'; key: string; body: Store.DurableObjectStore.Request }
  | { op: 'log'; key: string }
  | { op: 'legacy'; key: string; amount: string }
  | { op: 'increment-bigint'; key: string }
)

/** Runs one store operation inside workerd, against a real Durable Object or D1 database. */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const command = (await request.json()) as Command
    const options = { keyPrefix: 'prefix' in command ? command.prefix : undefined }
    const namespace =
      command.backend === 'recording'
        ? env.RECORDING
        : command.backend === 'rpc'
          ? env.RPC_STORE
          : command.backend === 'native'
            ? env.NATIVE_STORE
            : env.STORE
    const store =
      command.backend === 'd1'
        ? Store.d1(env.DB, options)
        : Store.durableObject(namespace, {
            ...options,
            ...(command.backend === 'rpc' ? { transport: 'rpc' } : {}),
            ...(command.backend === 'native' ? { encoding: 'native', transport: 'rpc' } : {}),
          })
    switch (command.op) {
      case 'get':
        return Response.json(await store.get(command.key))
      case 'put':
        await store.put(command.key, command.value)
        return Response.json(null)
      case 'delete':
        await store.delete(command.key)
        return Response.json(null)
      case 'increment':
        return Response.json(
          await store.update(command.key, (current) => {
            const value = ((current as number | null) ?? 0) + 1
            return { op: 'set', value, result: value }
          }),
        )
      case 'bigint': {
        await store.put(command.key, { amount: BigInt(command.amount) })
        const stored = (await store.get(command.key)) as { amount: bigint }
        return Response.json({ type: typeof stored.amount, amount: stored.amount.toString() })
      }
      case 'claim':
        return Response.json(await Store.tryClaim(store, command.key, command.expires))
      // Sends one operation to the key's object as is, such as a swap that conflicts.
      case 'raw':
        return namespace.get(namespace.idFromName(command.key)).fetch('https://mppx-store/', {
          body: JSON.stringify(command.body),
          method: 'POST',
        })
      // Writes a channel as a plain Durable Object does, then reads and updates it natively.
      case 'legacy': {
        const object = namespace.get(namespace.idFromName(command.key)) as unknown as RpcStore
        await object.legacyPut(command.key, {
          channelId: '0xabc',
          closed: false,
          deposit: 10n ** 20n,
          spent: BigInt(command.amount),
          vouchers: [{ nonce: 1n }],
        } satisfies Channel)
        const read = (await store.get(command.key)) as Channel
        const spent = await store.update(command.key, (current) => {
          const channel = current as Channel
          const next = { ...channel, spent: channel.spent + 1n }
          return { op: 'set', value: next, result: next.spent }
        })
        const raw = (await object.legacyGet(command.key)) as Channel
        return Response.json({
          read: { deposit: String(read.deposit), nonce: typeof read.vouchers[0]!.nonce },
          raw: { spent: typeof raw.spent === 'bigint' ? String(raw.spent) : raw.spent },
          spent: String(spent),
        })
      }
      case 'increment-bigint':
        return Response.json(
          String(
            await store.update(command.key, (current) => {
              const channel = (current as { spent: bigint; meta: { n: bigint[] } } | null) ?? {
                meta: { n: [0n] },
                spent: 0n,
              }
              const value = { meta: { n: [...channel.meta.n, 1n] }, spent: channel.spent + 1n }
              return { op: 'set', value, result: value.spent }
            }),
          ),
        )
      case 'log':
        return namespace.get(namespace.idFromName(command.key)).fetch('https://mppx-store/log', {
          method: 'POST',
        })
    }
  },
}
