import { systemPrompt } from '../src/agent.ts'
// Prints the system prompt for a fake run (no LLM call, no payment). Usage: pnpm exec tsx scripts/show-prompt.ts [on|off]
import { createRun } from '../src/events.ts'
const run = createRun('show-prompt', process.argv[2] !== 'off')
console.log(systemPrompt(run))
process.exit(0)
