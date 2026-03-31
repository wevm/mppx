import { execSync } from 'node:child_process'

const privateKey = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
const root = new URL('../..', import.meta.url).pathname

export default function globalSetup() {
  execSync(`LOCAL_ACCOUNT=${privateKey} pnpm build`, {
    cwd: root,
    stdio: 'inherit',
  })
}
