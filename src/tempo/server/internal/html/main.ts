import { Provider } from 'accounts'
import { Hex, Json } from 'ox'
import { createClient, custom, http } from 'viem'
import { tempoModerato, tempoLocalnet } from 'viem/chains'
import { Account } from 'viem/tempo'

import type * as Challenge from '../../../../Challenge.js'
import { tempo } from '../../../../client/index.js'
import * as Html from '../../../../server/internal/html/config.js'
import { submitCredential } from '../../../../server/internal/html/serviceWorker.client.js'
import type * as Methods from '../../../Methods.js'

const data = Json.parse(document.getElementById(Html.dataId)!.textContent) as {
  challenge: Challenge.FromMethods<[typeof Methods.charge]>
}

const root = document.getElementById('root')!

const h2 = document.createElement('h2')
h2.textContent = 'tempo'
root.appendChild(h2)

// Used for testing. TODO: Wire up more native way
const localTempoAccount = __LOCAL_ACCOUNT__
  ? Account.fromSecp256k1(__LOCAL_ACCOUNT__ as Hex.Hex)
  : undefined
declare const __LOCAL_ACCOUNT__: string | undefined

const provider = (() => {
  if (localTempoAccount) return undefined
  return Provider.create({
    testnet:
      data.challenge.request.methodDetails?.chainId === tempoModerato.id ||
      data.challenge.request.methodDetails?.chainId === tempoLocalnet.id,
  })
})()

const button = document.createElement('button')
button.textContent = 'Continue with Tempo'
button.onclick = async () => {
  try {
    button.disabled = true

    const client = (() => {
      const chain = [...(provider?.chains ?? []), tempoModerato, tempoLocalnet].find(
        (x) => x.id === data.challenge.request.methodDetails?.chainId,
      )
      if (localTempoAccount || !provider)
        return createClient({
          account: localTempoAccount,
          chain,
          transport: http(chain?.rpcUrls.default.http[0]),
        })
      return createClient({ chain, transport: custom(provider) })
    })()

    const account = await (async () => {
      if (localTempoAccount || !provider) return localTempoAccount
      const res = await provider.request({ method: 'wallet_connect' })
      return res.accounts[0]!.address
    })()
    const method = tempo({ account, getClient: () => client })[0]

    const credential = await method.createCredential({ challenge: data.challenge, context: {} })
    await submitCredential(credential)
  } finally {
    button.disabled = false
  }
}
root.appendChild(button)
