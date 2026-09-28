import { expect, test } from 'vp/test'

import { updateTimings } from './update-timings.js'

const current = { 'src/a.test.ts': 100, 'src/b.test.ts': 200 }
const suite = (name: string, durations: (number | null)[] = [10.2, 20.4]) => ({
  name: `/repo/src/${name}.test.ts`,
  status: 'passed',
  assertionResults: durations.map((duration) => ({ duration })),
})
const report = (...testResults: ReturnType<typeof suite>[]) => ({ success: true, testResults })

test('combines shard reports, rounds durations, and preserves suite membership and input', () => {
  expect(updateTimings(current, [report(suite('b')), report(suite('a', [40]))], '/repo')).toEqual({
    'src/a.test.ts': 40,
    'src/b.test.ts': 31,
  })
  expect(current).toEqual({ 'src/a.test.ts': 100, 'src/b.test.ts': 200 })
})

test('preserves skipped suite weights and accepts zero durations', () => {
  expect(updateTimings(current, [report(suite('a', [null]), suite('b', [0]))], '/repo')).toEqual({
    'src/a.test.ts': 100,
    'src/b.test.ts': 0,
  })
})

test.each([
  ['empty reports', [], 'Missing'],
  ['missing suite', [report(suite('a'))], 'Missing'],
  ['duplicate suite', [report(suite('a'), suite('a'), suite('b'))], 'Duplicate'],
  ['unknown suite', [report(suite('a'), suite('b'), suite('c'))], 'Unknown'],
  ['failed run', [{ ...report(suite('a'), suite('b')), success: false }], 'failed run'],
  ['failed suite', [report({ ...suite('a'), status: 'failed' }, suite('b'))], 'Failed Tempo'],
  ['negative duration', [report(suite('a', [-1]), suite('b'))], 'Invalid duration'],
  ['infinite duration', [report(suite('a', [Infinity]), suite('b'))], 'Invalid duration'],
  ['NaN duration', [report(suite('a', [NaN]), suite('b'))], 'Invalid duration'],
] as const)('rejects %s', (_, reports, message) => {
  expect(() => updateTimings(current, [...reports], '/repo')).toThrow(message)
})
