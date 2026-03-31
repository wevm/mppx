import { local, Provider, Storage } from 'accounts'
import { Hex, Json } from 'ox'
import { createClient, custom } from 'viem'
import { tempoModerato, tempoLocalnet } from 'viem/chains'
import { Account } from 'viem/tempo'

import type * as Challenge from '../../../../Challenge.js'
import { tempo } from '../../../../client/index.js'
import { submitCredential } from '../../../../server/internal/html/serviceWorker.client.js'
import type * as Methods from '../../../Methods.js'

const data = Json.parse(document.getElementById('__MPPX_DATA__')!.textContent) as {
  challenge: Challenge.FromMethods<[typeof Methods.charge]>
}

const localAccount = (typeof __LOCAL_ACCOUNT__ === 'string' && __LOCAL_ACCOUNT__) || undefined
declare const __LOCAL_ACCOUNT__: string | undefined

const provider = Provider.create({
  testnet:
    data.challenge.request.methodDetails?.chainId === tempoModerato.id ||
    data.challenge.request.methodDetails?.chainId === tempoLocalnet.id,
  ...(localAccount
    ? {
        adapter: local({
          loadAccounts: async () => ({
            accounts: [Account.fromSecp256k1(localAccount as Hex.Hex)],
          }),
        }),
        storage: Storage.memory(),
      }
    : undefined),
})
const chain =
  provider.chains.find((x) => x.id === data.challenge.request.methodDetails?.chainId) ??
  provider.chains.at(0)
const client = createClient({ chain, transport: custom(provider) })

const root = document.getElementById('root')!

const h2 = document.createElement('h2')
h2.textContent = 'tempo'
root.appendChild(h2)

const button = document.createElement('button')
button.textContent = 'Continue with Tempo'
button.onclick = async () => {
  try {
    button.disabled = true
    const result = await provider.request({ method: 'wallet_connect' })
    const account = result.accounts[0]!.address
    const method = tempo({ account, getClient: () => client })[0]
    const credential = await method.createCredential({ challenge: data.challenge, context: {} })
    await submitCredential(credential)
  } finally {
    button.disabled = false
  }
}
root.appendChild(button)
