import { relative } from 'node:path'

import { BaseSequencer, type TestSpecification } from 'vp/test/node'

import { tempoSuites } from './tempo-suites.js'

/** Balances serial integration shards by recorded duration, with stable tie-breaking. */
export default class Sequencer extends BaseSequencer {
  override async shard(files: TestSpecification[]) {
    if (files.some((file) => file.project.name !== 'tempo')) return super.shard(files)

    const { index, count } = this.ctx.config.shard!
    const shards = Array.from({ length: count }, () => ({
      files: [] as TestSpecification[],
      time: 0,
    }))
    const filename = (file: TestSpecification) =>
      relative(this.ctx.config.root, file.moduleId).replaceAll('\\', '/')
    const duration = (file: TestSpecification) => tempoSuites[filename(file)] ?? 0
    const sorted = [...files].sort(
      (a, b) => duration(b) - duration(a) || filename(a).localeCompare(filename(b)),
    )

    for (const file of sorted) {
      const shard = shards.reduce((a, b) => (a.time <= b.time ? a : b))
      shard.files.push(file)
      // Every file also pays worker startup/import costs, even with no timed tests.
      shard.time += duration(file) + 1_000
    }
    return shards[index - 1]!.files
  }
}
