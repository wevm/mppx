import * as child_process from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as readline from 'node:readline'

const examplesDir = path.join(import.meta.dirname, '..', 'examples')

const examples = fs.readdirSync(examplesDir).filter((name) => {
  const fullPath = path.join(examplesDir, name)
  return fs.statSync(fullPath).isDirectory() && name !== 'node_modules'
})

if (examples.length === 0) {
  console.log('No examples found in examples/')
  process.exit(1)
}

const arg = process.argv[2]

if (arg) {
  if (!examples.includes(arg)) {
    console.log(`Example "${arg}" not found. Available: ${examples.join(', ')}`)
    process.exit(1)
  }
  runExample(arg)
} else if (examples.length === 1) {
  runExample(examples[0]!)
} else {
  console.log('\nAvailable examples:\n')
  for (const [i, name] of examples.entries()) console.log(`  ${i + 1}. ${name}`)
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

function runExample(name: string) {
  console.log(`\nStarting ${name}...\n`)
  const child = child_process.spawn('pnpm', ['dev'], {
    cwd: path.join(examplesDir, name),
    stdio: 'inherit',
    shell: true,
  })
  child.on('exit', (code) => process.exit(code ?? 0))
}
