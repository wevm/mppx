import * as Challenge from '../Challenge.js'
import * as Extension from './Extension.js'
import { preparePayment } from './internal.js'

const challenge = Challenge.from({
  id: 'test',
  intent: 'charge',
  method: 'test',
  realm: 'example.com',
  request: { amount: '1' },
})

describe('Extension', () => {
  test('defines an extension without changing it', () => {
    const extension = { preparePayment: vi.fn() }
    expect(Extension.from(extension)).toBe(extension)
  })

  test('runs extensions in order and threads credential context', async () => {
    const calls: unknown[] = []
    const extensions = [
      Extension.from({
        preparePayment(context) {
          calls.push(context)
          return { credentialContext: { funded: true } }
        },
      }),
      Extension.from({
        preparePayment(context) {
          calls.push(context)
        },
      }),
    ]

    await expect(preparePayment(challenge, extensions, { account: 'alice' })).resolves.toEqual({
      funded: true,
    })
    expect(calls).toEqual([
      { challenge, credentialContext: { account: 'alice' } },
      { challenge, credentialContext: { funded: true } },
    ])
  })

  test.each([undefined, [], [Extension.from({})]])(
    'preserves context when no extension replaces it',
    async (extensions) => {
      const context = { account: 'alice' }
      await expect(preparePayment(challenge, extensions, context)).resolves.toBe(context)
    },
  )

  test('stops when an extension rejects payment', async () => {
    const later = vi.fn()
    await expect(
      preparePayment(challenge, [
        Extension.from({
          preparePayment() {
            throw new Error('blocked by policy')
          },
        }),
        Extension.from({ preparePayment: later }),
      ]),
    ).rejects.toThrow('blocked by policy')
    expect(later).not.toHaveBeenCalled()
  })
})
