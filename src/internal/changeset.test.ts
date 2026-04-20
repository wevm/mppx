import * as fs from 'node:fs'
import * as path from 'node:path'

import { describe, expect, test } from 'vp/test'

const changesetDir = path.resolve(import.meta.dirname, '../../.changeset')
const validPackages = new Set(['mppx'])
const validBumpTypes = new Set(['major', 'minor', 'patch', 'none'])

function getChangesetFiles() {
  return fs
    .readdirSync(changesetDir)
    .filter((f) => f.endsWith('.md') && f !== 'README.md' && !f.startsWith('.'))
}

function parseFrontmatter(content: string) {
  const match = content.match(/^\s*---\n([^]*?)\n\s*---/)
  if (!match) return undefined
  return match[1]
}

function parseReleases(frontmatter: string) {
  return [...frontmatter.matchAll(/^['"]?([^'":\n]+?)['"]?\s*:\s*(.+)$/gm)].map(
    ([, name, type]) => ({ name: name!.trim(), type: type!.trim().replace(/['"]/g, '') }),
  )
}

describe('changesets', () => {
  const files = getChangesetFiles()

  test('all changeset files have valid frontmatter fences', () => {
    for (const file of files) {
      const content = fs.readFileSync(path.join(changesetDir, file), 'utf-8')
      expect(content, `${file}: must start with "---"`).toMatch(/^---\n/)
      const closingIdx = content.indexOf('---', 3)
      expect(closingIdx, `${file}: missing closing "---" fence`).toBeGreaterThan(3)

      // closing fence must not have trailing non-whitespace (parser chokes)
      const afterClosing = content.slice(closingIdx + 3).split('\n')[0]!
      expect(afterClosing.trim(), `${file}: trailing characters after closing "---"`).toBe('')
    }
  })

  test('all changesets reference valid packages', () => {
    for (const file of files) {
      const content = fs.readFileSync(path.join(changesetDir, file), 'utf-8')
      const frontmatter = parseFrontmatter(content)
      if (!frontmatter) continue
      for (const { name } of parseReleases(frontmatter)) {
        expect(
          validPackages.has(name),
          `${file}: unknown package "${name}" (valid: ${[...validPackages].join(', ')})`,
        ).toBe(true)
      }
    }
  })

  test('all changesets use valid bump types', () => {
    for (const file of files) {
      const content = fs.readFileSync(path.join(changesetDir, file), 'utf-8')
      const frontmatter = parseFrontmatter(content)
      if (!frontmatter) continue
      for (const { name, type } of parseReleases(frontmatter)) {
        expect(
          validBumpTypes.has(type),
          `${file}: invalid bump type "${type}" for "${name}" (valid: major, minor, patch, none)`,
        ).toBe(true)
      }
    }
  })

  test('no changeset uses major bump (pre-v1 policy)', () => {
    for (const file of files) {
      const content = fs.readFileSync(path.join(changesetDir, file), 'utf-8')
      const frontmatter = parseFrontmatter(content)
      if (!frontmatter) continue
      for (const { name, type } of parseReleases(frontmatter)) {
        expect(type, `${file}: "${name}" uses major bump — pre-v1 policy forbids this`).not.toBe(
          'major',
        )
      }
    }
  })

  test('all changesets have a non-empty description', () => {
    for (const file of files) {
      const content = fs.readFileSync(path.join(changesetDir, file), 'utf-8')
      const match = content.match(/^\s*---[^]*?---\s*(.*)$/s)
      expect(match?.[1]?.trim(), `${file}: changeset has an empty description`).toBeTruthy()
    }
  })

  test('no duplicate package entries in frontmatter', () => {
    for (const file of files) {
      const content = fs.readFileSync(path.join(changesetDir, file), 'utf-8')
      const frontmatter = parseFrontmatter(content)
      if (!frontmatter) continue
      const releases = parseReleases(frontmatter)
      const seen = new Set<string>()
      for (const { name } of releases) {
        expect(seen.has(name), `${file}: duplicate entry for "${name}"`).toBe(false)
        seen.add(name)
      }
    }
  })
})
