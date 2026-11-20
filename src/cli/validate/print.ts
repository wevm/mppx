import type { CheckResult } from '../../validation/helpers.js'
import { pc } from '../utils.js'

const SEVERITY_ICONS = {
  pass: pc.green('✓'),
  fail: pc.red('✗'),
  warn: pc.yellow('⚠'),
  suggested: pc.cyan('◇'),
  skip: pc.dim('○'),
} as const

export function printCheck(result: CheckResult) {
  const icon = SEVERITY_ICONS[result.severity]
  const text = result.detail ? `${result.label} (${result.detail})` : result.label
  console.log(`  ${icon} ${text}`)
  if (result.hint && result.severity !== 'pass') {
    console.log(pc.dim(`    → ${result.hint}`))
  }
}

export function printSection(title: string) {
  console.log(`\n${pc.bold(title)}`)
}

export type Counts = {
  passed: number
  failed: number
  warnings: number
  suggested: number
  skipped: number
}

export function printResults(results: CheckResult[], counts: Counts) {
  for (const result of results) {
    printCheck(result)
    if (result.severity === 'pass') counts.passed++
    else if (result.severity === 'fail') counts.failed++
    else if (result.severity === 'warn') counts.warnings++
    else if (result.severity === 'suggested') counts.suggested++
    else if (result.severity === 'skip') counts.skipped++
  }
}
