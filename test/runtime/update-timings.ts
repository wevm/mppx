import { relative } from 'node:path'

type Report = {
  success: boolean
  testResults: {
    name: string
    status: string
    assertionResults: { duration?: number | null }[]
  }[]
}

/** Refreshes weights from complete, successful shard reports without changing suite membership. */
export function updateTimings(current: Record<string, number>, reports: Report[], root: string) {
  const timings = { ...current }
  const seen = new Set<string>()
  for (const report of reports) {
    if (!report.success) throw new Error('Cannot rebalance from a failed run')
    for (const suite of report.testResults) {
      const file = relative(root, suite.name).replaceAll('\\', '/')
      if (!Object.hasOwn(current, file)) throw new Error(`Unknown Tempo suite: ${file}`)
      if (seen.has(file)) throw new Error(`Duplicate Tempo suite: ${file}`)
      if (suite.status !== 'passed') throw new Error(`Failed Tempo suite: ${file}`)
      seen.add(file)
      const durations = suite.assertionResults.flatMap(({ duration }) =>
        duration == null ? [] : [duration],
      )
      if (durations.some((duration) => !Number.isFinite(duration) || duration < 0))
        throw new Error(`Invalid duration: ${file}`)
      // Preserve the weight for suites skipped by this runner's configuration.
      if (durations.length)
        timings[file] = Math.round(durations.reduce((sum, duration) => sum + duration, 0))
    }
  }
  for (const file of Object.keys(current))
    if (!seen.has(file)) throw new Error(`Missing Tempo suite: ${file}`)
  return timings
}
