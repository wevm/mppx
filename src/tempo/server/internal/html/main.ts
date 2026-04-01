import { local, Provider } from 'accounts'
import { Json } from 'ox'
import { createClient, custom, http } from 'viem'
import { tempoModerato, tempoLocalnet } from 'viem/chains'

import type * as Challenge from '../../../../Challenge.js'
import { tempo } from '../../../../client/index.js'
import * as Html from '../../../../server/internal/html/config.js'
import { submitCredential } from '../../../../server/internal/html/serviceWorker.client.js'
import type * as Methods from '../../../Methods.js'

const data = Json.parse(document.getElementById(Html.dataId)!.textContent) as {
  config: {}
  challenge: Challenge.FromMethods<[typeof Methods.charge]>
  theme: {
    [k in keyof Omit<Html.Theme, 'fontUrl' | 'logo'>]-?: NonNullable<Html.Theme[k]>
  }
}

const root = document.getElementById('root')!

const h2 = document.createElement('h2')
h2.textContent = 'tempo'
root.appendChild(h2)

const provider = Provider.create({
  // Dead code eliminated from production bundle (including top-level imports)
  ...(import.meta.env.MODE === 'test'
    ? {
        adapter: local({
          async loadAccounts() {
            const { generatePrivateKey } = await import('viem/accounts')
            const { Account, Actions } = await import('viem/tempo')
            const privateKey = generatePrivateKey()
            const account = Account.fromSecp256k1(privateKey)
            const client = createClient({
              chain: [tempoModerato, tempoLocalnet].find(
                (x) => x.id === data.challenge.request.methodDetails?.chainId,
              ),
              transport: http(),
            })
            await Actions.faucet.fundSync(client, { account })
            return {
              accounts: [account],
            }
          },
        }),
      }
    : {}),
  testnet:
    data.challenge.request.methodDetails?.chainId === tempoModerato.id ||
    data.challenge.request.methodDetails?.chainId === tempoLocalnet.id,
})

const button = document.createElement('button')
button.textContent = 'Continue with Tempo'
button.onclick = async () => {
  try {
    button.disabled = true

    const chain = [...(provider?.chains ?? []), tempoModerato, tempoLocalnet].find(
      (x) => x.id === data.challenge.request.methodDetails?.chainId,
    )
    const client = createClient({ chain, transport: custom(provider) })
    const result = await provider.request({ method: 'wallet_connect' })
    const account = result.accounts[0]?.address
    const method = tempo({ account, getClient: () => client })[0]

    const credential = await method.createCredential({ challenge: data.challenge, context: {} })
    await submitCredential(credential)
  } finally {
    button.disabled = false
  }
}
root.appendChild(button)
