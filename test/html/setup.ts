import { createClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { tempoModerato } from 'viem/chains'
import { Actions } from 'viem/tempo'

const privateKey = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
const account = privateKeyToAccount(privateKey)

export async function setup() {
  // Fund the test payer account via faucet
  const client = createClient({ chain: tempoModerato, transport: http() })
  await Actions.faucet.fundSync(client, { account })
  console.log(`funded ${account.address}`)
}
