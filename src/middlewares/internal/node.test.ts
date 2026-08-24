import { describe, expect, test } from 'vp/test'

import { toRequest } from './node.js'

describe('toRequest', () => {
  test('preserves parsed bodies and repeated headers', async () => {
    const request = toRequest({
      body: { message: 'preserved' },
      headers: { 'content-type': 'application/json', 'x-value': ['first', 'second'] },
      method: 'POST',
      url: 'https://example.com/api/echo?source=test',
    })

    expect(request.method).toBe('POST')
    expect(request.url).toBe('https://example.com/api/echo?source=test')
    expect(await request.json()).toEqual({ message: 'preserved' })
    expect(request.headers.get('x-value')).toBe('first, second')
  })

  test.each(['GET', 'HEAD'])('drops parsed bodies from %s requests', async (method) => {
    const request = toRequest({
      body: { ignored: true },
      headers: {},
      method,
      url: 'https://example.com/api/data',
    })

    expect(request.body).toBeNull()
  })
})
