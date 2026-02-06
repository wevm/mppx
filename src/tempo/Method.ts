import * as Method from '../Method.js'
import * as Intents from './Intents.js'

export const tempo = Method.from({
  intents: {
    charge: Intents.charge,
    stream: Intents.stream,
  },
  name: 'tempo',
})
