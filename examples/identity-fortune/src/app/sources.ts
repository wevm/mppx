// The source files the page shows: the real files of this example, imported as text.
// Steps the server reports (`// step: <id>`) and client markers (`// prover: <id>`) map
// to the line under their marker.
import client from '../client.ts?raw'
import fortune from '../fortune.ts?raw'
import issuer from '../issuer.ts?raw'
import server from '../server.ts?raw'
import tiers from '../tiers.ts?raw'

export const files = [
  { name: 'server.ts', contents: server },
  { name: 'tiers.ts', contents: tiers },
  { name: 'issuer.ts', contents: issuer },
  { name: 'fortune.ts', contents: fortune },
  { name: 'client.ts', contents: client },
] as const

export type FileName = (typeof files)[number]['name']

/** Where each marker is: its file and the lines of the block under it. */
export const markers = new Map<string, { file: FileName; start: number; end: number }>()
for (const file of files) {
  const lines = file.contents.split('\n')
  lines.forEach((line, index) => {
    const match = line.match(/\/\/ (?:step|prover): ([\w.-]+)/)
    if (!match) return
    const id = line.includes('prover:') ? `client.prover.${match[1]}` : match[1]!
    if (markers.has(id)) return
    // The block runs to the next blank line or marker.
    let end = index + 1
    while (
      end + 1 < lines.length &&
      lines[end + 1]!.trim() &&
      !/\/\/ (step|prover):/.test(lines[end + 1]!)
    )
      end++
    markers.set(id, { file: file.name, start: index + 1, end: end + 1 })
  })
}
