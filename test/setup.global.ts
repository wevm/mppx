import { tempoNetworkConfig } from './config.js'
import { setupTempoNetwork } from './tempo/setup.js'

export default async function () {
  if (!tempoNetworkConfig.enabled) {
    console.log('Tempo RPC setup skipped')
    return
  }

  await setupTempoNetwork()
  console.log(`Tempo RPC ready at ${tempoNetworkConfig.rpcUrl}`)
}
