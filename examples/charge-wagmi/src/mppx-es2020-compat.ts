import { Challenge } from 'mppx'

// Included by the ES2020 example tsconfig to catch library APIs that require newer libs.
export const serializedChallenge = Challenge.serialize(
  Challenge.from({
    id: 'abc123',
    realm: 'api.example.com',
    method: 'tempo',
    intent: 'charge',
    request: { amount: '1000000', currency: 'USD' },
    description: 'Pay "premium" path C:\\tempo\\api',
  }),
)
