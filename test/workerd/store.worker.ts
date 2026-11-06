import * as Store from '../../src/Store.js'

/** The store's Durable Object class, bound as `STORE`. */
export class MppxStore extends Store.DurableObjectStore {}

/** Records every write and the alarms it schedules, bound as `RECORDING`. */
export class RecordingStore extends Store.DurableObjectStore {
  protected override async onWrite(
    key: string,
    previous: unknown,
    next: unknown,
    storage: Store.DurableObjectStore.Storage,
  ) {
    const writes = JSON.parse(((await storage.get('__writes')) as string | undefined) ?? '[]')
    writes.push({ key, previous, next })
    await storage.put('__writes', JSON.stringify(writes))
    await storage.setAlarm!(Date.now() + 10)
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

/** Counts its writes, and fails the next one once armed, bound as `FAILING`. */
export class FailingStore extends Store.DurableObjectStore {
  private armed = false

  protected override async onWrite(
    _key: string,
    _previous: unknown,
    _next: unknown,
    storage: Store.DurableObjectStore.Storage,
  ) {
    await storage.put('__hooked', String(Number((await storage.get('__hooked')) ?? 0) + 1))
    if (!this.armed) return
    this.armed = false
    throw new Error('onWrite failed')
  }

  override async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url)
    if (pathname === '/arm') {
      this.armed = true
      return Response.json(true)
    }
    if (pathname === '/hooked')
      return Response.json(Number((await this.storage.get('__hooked')) ?? 0))
    return super.fetch(request)
  }
}

type Env = {
  FAILING: Store.durableObject.Namespace
  DB: Store.d1.Database
  RECORDING: Store.durableObject.Namespace
  STORE: Store.durableObject.Namespace
}

type Command = { backend?: 'd1' | 'durableObject' | 'failing' | 'recording' } & (
  | { op: 'get' | 'delete'; key: string; prefix?: string }
  | { op: 'put'; key: string; value: unknown; prefix?: string }
  | { op: 'increment'; key: string }
  | { op: 'bigint'; key: string; amount: string }
  | { op: 'claim'; key: string; expires: number }
  | { op: 'raw'; key: string; body: Store.DurableObjectStore.Request }
  | { op: 'log'; key: string }
  | { op: 'arm' | 'hooked'; key: string }
)

/** Runs one store operation inside workerd, against a real Durable Object or D1 database. */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const command = (await request.json()) as Command
    const options = { keyPrefix: 'prefix' in command ? command.prefix : undefined }
    const namespace =
      command.backend === 'failing'
        ? env.FAILING
        : command.backend === 'recording'
          ? env.RECORDING
          : env.STORE
    const store =
      command.backend === 'd1' ? Store.d1(env.DB, options) : Store.durableObject(namespace, options)
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
      case 'log':
      case 'arm':
      case 'hooked':
        return namespace
          .get(namespace.idFromName(command.key))
          .fetch(`https://mppx-store/${command.op}`, { method: 'POST' })
    }
  },
}
