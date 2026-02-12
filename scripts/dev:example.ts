import * as child_process from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as readline from 'node:readline'

const examplesDir = path.join(import.meta.dirname, '..', 'examples')

function findExamples(dir: string, prefix = ''): { name: string; path: string }[] {
  const entries = fs.readdirSync(dir).filter((name) => {
    const fullPath = path.join(dir, name)
    return fs.statSync(fullPath).isDirectory() && name !== 'node_modules'
  })

  const results: { name: string; path: string }[] = []
  for (const entry of entries) {
    const fullPath = path.join(dir, entry)
    const label = prefix ? `${prefix}/${entry}` : entry
    if (fs.existsSync(path.join(fullPath, 'package.json'))) {
      results.push({ name: label, path: fullPath })
    } else {
      results.push(...findExamples(fullPath, label))
    }
  }
  return results
}

const examples = findExamples(examplesDir)

if (examples.length === 0) {
  console.log('No examples found in examples/')
  process.exit(1)
}

const arg = process.argv[2]

if (arg) {
  const match = examples.find((e) => e.name === arg)
  if (!match) {
    console.log(`Example "${arg}" not found. Available: ${examples.map((e) => e.name).join(', ')}`)
    process.exit(1)
  }
  runExample(match)
} else if (examples.length === 1) {
  runExample(examples[0]!)
} else {
  console.log('\nAvailable examples:\n')
  for (const [i, example] of examples.entries()) console.log(`  ${i + 1}. ${example.name}`)
  console.log()

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  rl.question('Select example (number): ', (answer) => {
    rl.close()
    const index = parseInt(answer, 10) - 1
    if (index >= 0 && index < examples.length) {
      runExample(examples[index]!)
    } else {
      console.log('Invalid selection')
      process.exit(1)
    }
  })
}

function runExample(example: { name: string; path: string }) {
  console.log(`\nStarting ${example.name}...\n`)
  const child = child_process.spawn('pnpm', ['dev'], {
    cwd: example.path,
    stdio: 'inherit',
    shell: true,
  })
  child.on('exit', (code) => process.exit(code ?? 0))
}
