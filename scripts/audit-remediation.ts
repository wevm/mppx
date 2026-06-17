import * as cp from 'node:child_process'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

type Advisory = {
  id: string
  name: string
  patched: string
  severity?: string
  title?: string
  url?: string
  versions: string[]
  vulnerable: string
}

const command = process.argv[2]

if (command === 'detect') detect()
else if (command === 'analyze') analyze()
else if (command === 'apply') apply()
else throw new Error(`Unknown command: ${command ?? ''}`)

function detect() {
  const runId = env('FAILED_RUN_ID')
  const repository = env('REPOSITORY')
  const stepName = env('AUDIT_STEP_NAME', 'Audit dependencies')
  const jobs = JSON.parse(
    run(`gh api ${quote(`repos/${repository}/actions/runs/${runId}/jobs?per_page=100`)}`, {
      silent: true,
    }),
  )
  const failedJob = jobs.jobs?.find(
    (job: any) =>
      job.conclusion === 'failure' &&
      job.steps?.some((step: any) => step.name === stepName && step.conclusion === 'failure'),
  )

  output('failed-job-url', failedJob?.html_url ?? '')
  output('should-run', String(Boolean(failedJob)))
  if (!failedJob) summary(`No failed "${stepName}" step found. Skipping remediation.`)
}

function analyze() {
  const advisories = audit()
  if (advisories.length === 0) {
    output('fixable', 'false')
    summary('No audit advisories were reported.')
    return
  }

  const branch = `${env('BRANCH_PREFIX', 'automation/audit').replace(/\/+$/, '')}/${fingerprint(advisories)}`
  const bodyPath = env('PR_BODY_PATH', '.audit-remediation-pr-body.md')
  fs.writeFileSync(bodyPath, prBody(advisories))

  output('branch', branch)
  output('fixable', String(fixes(advisories).length > 0))
  output('pr-body-path', bodyPath)
  summary(`Audit remediation branch: \`${branch}\``)
}

function apply() {
  if (env('PACKAGE_MANAGER', 'pnpm') !== 'pnpm') throw new Error('Only pnpm is supported.')

  const currentFixes = fixes(audit())
  if (currentFixes.length === 0) {
    output('fixable', 'false')
    summary('No advisories had a parseable patched version.')
    return
  }

  const overridePath = path.resolve(process.cwd(), env('OVERRIDE_FILE', 'pnpm-workspace.yaml'))
  fs.writeFileSync(
    overridePath,
    updateWorkspace(fs.readFileSync(overridePath, 'utf8'), currentFixes),
  )
  run(env('INSTALL_COMMAND', 'pnpm install'))

  const remaining = audit()
  output('fixable', String(remaining.length === 0))
  if (remaining.length > 0) {
    summary(
      [
        'Audit remediation did not clear all advisories. No pull request will be opened.',
        '',
        ...remaining.map((advisory) => `- ${advisory.name}: >=${advisory.patched}`),
      ].join('\n'),
    )
  }
}

function audit(): Advisory[] {
  const text = run(env('AUDIT_COMMAND', 'pnpm audit --json --ignore-registry-errors'), {
    allowFailure: true,
    silent: true,
  })
  const report = JSON.parse(text.slice(text.indexOf('{')))
  return Object.entries(report.advisories ?? {})
    .map(([id, value]: [string, any]) => ({
      id,
      name: value.module_name,
      patched: value.patched_versions?.match(/>=\s*([0-9][0-9A-Za-z.+-]*)/)?.[1],
      severity: value.severity,
      title: value.title,
      url: value.url,
      versions: [
        ...new Set((value.findings ?? []).map((finding: any) => finding.version).filter(Boolean)),
      ].sort(),
      vulnerable: value.vulnerable_versions,
    }))
    .filter((advisory) => advisory.name && advisory.patched && advisory.vulnerable)
    .sort((a, b) => `${a.id}:${a.name}`.localeCompare(`${b.id}:${b.name}`))
}

function fixes(advisories: Advisory[]) {
  return [
    ...new Map(
      advisories.map((advisory) => [
        `${advisory.name}@${advisory.vulnerable}`,
        {
          exclude: `${advisory.name}@${advisory.patched}`,
          override: `  ${advisory.name}@${advisory.vulnerable}: '${advisory.patched}'`,
        },
      ]),
    ).values(),
  ].sort((a, b) => a.override.localeCompare(b.override))
}

function fingerprint(advisories: Advisory[]) {
  return createHash('sha256')
    .update(
      JSON.stringify(
        advisories.map(({ id, name, patched, versions, vulnerable }) => ({
          id,
          name,
          patched,
          versions,
          vulnerable,
        })),
      ),
    )
    .digest('hex')
    .slice(0, 12)
}

function prBody(advisories: Advisory[]) {
  return [
    '## Summary',
    '',
    `- ${env('PR_BODY_SUMMARY', 'Updated vulnerable dependencies reported by `pnpm audit`')}`,
    `- Failed CI: ${env('FAILED_CI_URL', 'Unavailable')}`,
    '',
    '## Advisories',
    '',
    ...advisories.map((advisory) => {
      const severity = advisory.severity ? `${advisory.severity}: ` : ''
      const title = advisory.title ? ` - ${advisory.title}` : ''
      const url = advisory.url ? ` (${advisory.url})` : ''
      return `- ${severity}${advisory.name}, patched >=${advisory.patched}${title}${url}`
    }),
    '',
  ].join('\n')
}

function updateWorkspace(content: string, entries: ReturnType<typeof fixes>) {
  let next = upsert(
    content,
    'overrides',
    entries.map((entry) => entry.override),
  )
  if (next.split('\n').includes('minimumReleaseAgeExclude:')) {
    next = upsert(
      next,
      'minimumReleaseAgeExclude',
      entries.map((entry) => entry.exclude),
      (value) => `  - ${value}`,
    )
  }
  return next
}

function upsert(
  content: string,
  section: string,
  values: string[],
  format = (value: string) => value,
) {
  const lines = (content.endsWith('\n') ? content : `${content}\n`).split('\n')
  const start = lines.findIndex((line) => line === `${section}:`)
  if (start === -1) return `${content.trimEnd()}\n\n${section}:\n${values.map(format).join('\n')}\n`

  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\S.*:/.test(lines[i] ?? '')) {
      end = i
      break
    }
  }

  let insertAt = end
  while (insertAt > start + 1 && lines[insertAt - 1]?.trim() === '') insertAt--
  for (const value of values) {
    const formatted = format(value)
    const key = formatted.trim().split(':')[0]
    const exists = lines
      .slice(start + 1, end)
      .some((line) => line.trim() === formatted.trim() || line.trim().startsWith(`${key}:`))
    if (!exists) {
      lines.splice(insertAt++, 0, formatted)
    }
  }
  return lines.join('\n')
}

function run(command: string, options: { allowFailure?: boolean; silent?: boolean } = {}) {
  const result = cp.spawnSync(command, {
    encoding: 'utf8',
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (!options.silent && result.stdout) process.stdout.write(result.stdout)
  if (!options.silent && result.stderr) process.stderr.write(result.stderr)
  if (!options.allowFailure && result.status !== 0) throw new Error(`Command failed: ${command}`)
  return `${result.stdout ?? ''}${result.stderr ?? ''}`
}

function env(name: string, fallback?: string) {
  const value = process.env[name] || fallback
  if (value === undefined) throw new Error(`${name} is required.`)
  return value
}

function output(name: string, value: string) {
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`)
}

function summary(value: string) {
  if (process.env.GITHUB_STEP_SUMMARY)
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${value}\n`)
}

function quote(value: string) {
  return `'${value.split("'").join("'\\''")}'`
}
