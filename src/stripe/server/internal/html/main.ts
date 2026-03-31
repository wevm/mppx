import type * as Challenge from '../../../../Challenge.js'
import type * as Methods from '../../../Methods.js'

const data = JSON.parse(document.getElementById('__MPPX_DATA__')!.textContent!) as {
  challenge: Challenge.FromMethods<[typeof Methods.charge]>
}
console.log(data.challenge)

const root = document.getElementById('root')!

const h2 = document.createElement('h2')
h2.textContent = 'stripe'
root.appendChild(h2)
