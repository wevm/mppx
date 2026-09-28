import { globSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import fc from 'fast-check'
import { describe, expect, test } from 'vp/test'
import type { TestSpecification, Vitest } from 'vp/test/node'

import Sequencer from './Sequencer.js'
import { tempoSuites } from './tempo-suites.js'

const root = resolve(import.meta.dirname, '../..')

function shard(files: string[], index: number, count: number) {
  const sequencer = new Sequencer({ config: { root, shard: { index, count } } } as Vitest)
  return sequencer.shard(
    files.map((file) => ({ moduleId: resolve(root, file) }) as TestSpecification),
  )
}

describe('runtime sharding', () => {
  test('balances the slowest integration suites instead of splitting by file count', async () => {
    const files = Object.keys(tempoSuites)
    const shards = await Promise.all([shard(files, 1, 2), shard(files, 2, 2)])
    const durations = shards.map((files) =>
      files.reduce(
        (sum, file) => sum + tempoSuites[file.moduleId.slice(root.length + 1)]! + 1_000,
        0,
      ),
    )
    expect(Math.abs(durations[0]! - durations[1]!)).toBeLessThan(2_000)
  })

  test('assigns every file exactly once, independently of discovery order', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.shuffledSubarray(Object.keys(tempoSuites)),
        fc.integer({ min: 1, max: 8 }),
        async (files, count) => {
          const shards = await Promise.all(
            Array.from({ length: count }, (_, i) => shard(files, i + 1, count)),
          )
          expect(
            shards
              .flat()
              .map((file) => file.moduleId)
              .sort(),
          ).toEqual(files.map((file) => resolve(root, file)).sort())
          expect(await shard([...files].reverse(), 1, count)).toEqual(shards[0])
        },
      ),
    )
  })

  test('includes new files without recorded timings', async () => {
    const files = ['new-a.test.ts', 'new-b.test.ts', 'new-c.test.ts']
    const shards = await Promise.all([shard(files, 1, 2), shard(files, 2, 2)])
    expect(shards.map((files) => files.length)).toEqual([2, 1])
  })

  test('keeps suites importing shared chain fixtures out of parallel projects', () => {
    const files = globSync('**/*.test.ts', {
      cwd: resolve(root, 'src'),
      exclude: ['**/node_modules/**'],
    })
    for (const file of files.filter((file) => file.endsWith('.test.ts'))) {
      const source = readFileSync(resolve(root, 'src', file), 'utf8')
      if (/from ['"]~test\/tempo\//.test(source))
        expect(Object.keys(tempoSuites)).toContain(`src/${file}`)
    }
  })
})
