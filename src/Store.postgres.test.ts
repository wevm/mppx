import { spawnSync } from 'node:child_process'

import { Pool } from 'pg'
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers'
import { afterAll, beforeAll, describe, expect, test } from 'vp/test'

import * as Store from './Store.js'

// Runs Store.postgres() against a real Postgres server through a pool of 20
// connections, so statements race on separate backends with real row locks,
// which the single-connection PGlite in Store.test.ts cannot do. Skipped
// where Docker is unavailable.
const docker = spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0

describe.skipIf(!docker)('Store.postgres against a Postgres server', () => {
  let container: StartedTestContainer
  let pool: Pool

  beforeAll(async () => {
    container = await new GenericContainer('postgres:17-alpine')
      .withEnvironment({ POSTGRES_PASSWORD: 'mppx' })
      .withExposedPorts(5432)
      .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
      .start()
    pool = new Pool({
      connectionString: `postgres://postgres:mppx@${container.getHost()}:${container.getMappedPort(5432)}/postgres`,
      max: 20,
    })
  }, 120_000)

  afterAll(async () => {
    await pool?.end()
    await container?.stop()
  })

  test('update stays atomic across concurrent connections', async () => {
    const store = Store.postgres(pool, { table: 'mppx_update' })
    const results = await Promise.all(
      Array.from({ length: 200 }, () =>
        store.update('counter', (current) => {
          const value = ((current as number | null) ?? 0) + 1
          return { op: 'set', value, result: value }
        }),
      ),
    )
    expect(new Set(results).size).toBe(200)
    expect(await store.get('counter')).toBe(200)
  })

  test('tryClaim records a key once across concurrent connections', async () => {
    const store = Store.postgres(pool, { table: 'mppx_claim' })
    const expires = Date.now() + 60_000
    const results = await Promise.all(
      Array.from({ length: 100 }, () => Store.tryClaim(store, 'nonce', expires)),
    )
    expect(results.filter(Boolean)).toHaveLength(1)
  })

  test('concurrent stores create the same table without failing', async () => {
    // Separate store instances share no in-process guard, like separate servers.
    const stores = Array.from({ length: 20 }, () =>
      Store.postgres(pool, { table: 'mppx_concurrent_create' }),
    )
    await Promise.all(stores.map((store, i) => store.put(`k${i}`, i)))
    expect(await stores[0]!.get('k19')).toBe(19)
  })

  test('works in a schema-qualified table', async () => {
    await pool.query('CREATE SCHEMA IF NOT EXISTS billing')
    const store = Store.postgres(pool, { table: 'billing.mppx_store' })
    await store.put('k', { amount: 1n })
    expect(await store.get('k')).toEqual({ amount: 1n })
    expect(await Store.tryClaim(store, 'n', Date.now() + 60_000)).toBe(true)
  })
})
