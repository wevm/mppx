import { Provider } from 'accounts'
import { Json } from 'ox'
import { createClient, custom } from 'viem'

import type * as Challenge from '../../../../Challenge.js'
import { tempo } from '../../../../client/index.js'
import type * as Methods from '../../../Methods.js'

const data = Json.parse(document.getElementById('__MPPX_DATA__')!.textContent) as {
  challenge: Challenge.FromMethods<[typeof Methods.charge]>
}

const provider = Provider.create()

const root = document.getElementById('root')!

const h2 = document.createElement('h2')
h2.textContent = 'tempo'
root.appendChild(h2)

const button = document.createElement('button')
button.textContent = 'Continue with Tempo'
button.onclick = async () => {
  const result = await provider.request({ method: 'wallet_connect' })
  const account = result.accounts[0]!.address
  console.log(account)

  const chain =
    provider.chains.find((x) => x.id === data.challenge.request.methodDetails?.chainId) ??
    provider.chains.at(0)
  const client = createClient({ chain, transport: custom(provider) })
  const method = tempo({ account, getClient: () => client })[0]
  const credential = await method.createCredential({ challenge: data.challenge, context: {} })

  const res = await fetch(location.pathname, {
    headers: { Authorization: credential },
  })
  console.log(await res.json())
}
root.appendChild(button)
