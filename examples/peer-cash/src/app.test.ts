import assert from 'node:assert/strict'
import test from 'node:test'

import { usdc } from '@zkp2p/cash'

import { createApp } from './app.js'

test('prepares one unsigned plan from confirmed MPP revenue', async () => {
  const amounts: bigint[] = []
  const { adminApp, revenue } = createApp({
    cash: {
      async prepare(input) {
        amounts.push(input.amount)
        return {
          accessPolicyRequired: false,
          register: { hashedOnchainIds: [] },
          steps: [],
          txs: [],
        }
      },
    },
    cashout: { currency: 'USD', payee: 'merchant', platform: 'revolut' },
    facilitator: 'https://facilitator.example',
    recipient: '0x0000000000000000000000000000000000000001',
    secretKey: 'test-secret-key-test-secret-key-32',
  })
  revenue.record('0xsettlement', usdc('10'))

  const response = await adminApp.request('http://localhost/cashout', {
    body: JSON.stringify({}),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  })

  assert.equal(response.status, 200)
  assert.deepEqual(amounts, [usdc('10')])
  assert.equal((await response.json()).revenue.availableUsdc, '0')

  const duplicate = await adminApp.request('http://localhost/cashout', {
    body: JSON.stringify({}),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  })
  assert.equal(duplicate.status, 409)
})

test('releases revenue when a payout needs an unsupported follow-up', async () => {
  const { adminApp, revenue } = createApp({
    cash: {
      async prepare() {
        return {
          accessPolicyRequired: true,
          register: { hashedOnchainIds: [] },
          steps: [],
          txs: [],
        }
      },
    },
    cashout: { currency: 'USD', payee: 'merchant', platform: 'venmo' },
    facilitator: 'https://facilitator.example',
    recipient: '0x0000000000000000000000000000000000000001',
    secretKey: 'test-secret-key-test-secret-key-32',
  })
  revenue.record('0xsettlement', usdc('10'))

  const response = await adminApp.request('http://localhost/cashout', {
    body: JSON.stringify({}),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  })

  assert.equal(response.status, 400)
  assert.equal(revenue.snapshot().available, usdc('10'))
})
