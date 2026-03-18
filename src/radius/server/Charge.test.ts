import { Receipt } from 'mppx'
import { Mppx as Mppx_client, radius as radius_client } from 'mppx/client'
import { Mppx as Mppx_server, radius as radius_server } from 'mppx/server'
import { parseUnits } from 'viem'
import { getBalance, readContract } from 'viem/actions'
import { describe, expect, test } from 'vitest'
import * as Http from '~test/Http.js'
import {
  addressUrl,
  alice,
  aliceClient,
  bob,
  bobClient,
  chain,
  explorerUrl,
  hasAccounts,
  network,
  publicClient,
  token,
  txUrl,
} from '~test/radius/viem.js'

// ---------------------------------------------------------------------------
// Skip the entire suite when wallet keys are not configured.
// ---------------------------------------------------------------------------

const describeRadius = hasAccounts ? describe : describe.skip

const realm = 'api.radius-test.example'
const secretKey = 'radius-test-secret-key'

// Amount: 0.001 of the settlement token.
const chargeAmount = '0.001'
const chargeRaw = parseUnits(chargeAmount, token.decimals)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const erc20BalanceAbi = [
  {
    type: 'function',
    name: 'balanceOf',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
] as const

async function tokenBalance(owner: `0x${string}`): Promise<bigint> {
  // Native RUSD (zero-address sentinel) → use getBalance; otherwise ERC-20.
  if (token.address === '0x0000000000000000000000000000000000000000') {
    return getBalance(publicClient, { address: owner })
  }
  return readContract(publicClient, {
    address: token.address,
    abi: erc20BalanceAbi,
    functionName: 'balanceOf',
    args: [owner],
  })
}

function logExplorerLinks(label: string, hash: string) {
  console.log(`  [${label}] tx: ${txUrl(hash)}`)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeRadius('radius', () => {
  // Print network info once so CI logs show what's being tested.
  test('network info', () => {
    console.log(`  Network:  ${network} (chainId ${chain.id})`)
    console.log(`  Explorer: ${explorerUrl}`)
    console.log(`  Token:    ${token.symbol} (${token.decimals} decimals) @ ${token.address}`)
    console.log(`  Alice:    ${addressUrl(alice.address)}`)
    console.log(`  Bob:      ${addressUrl(bob.address)}`)
    expect(true).toBe(true)
  })

  // --------------------------------------------------------------------------
  // Test 1 — Alice pays Bob 0.001 SBC to access a resource.
  //
  //   Alice requests a resource from Bob's server.
  //   Bob responds with HTTP 402 requiring 0.001 SBC.
  //   Alice pays via ERC-20 transfer (push mode) and receives the resource.
  // --------------------------------------------------------------------------
  describe('resource access: Alice pays Bob for a resource', () => {
    test('Alice pays 0.001 SBC and receives the protected resource', async () => {
      // --- balances before ---
      const aliceBefore = await tokenBalance(alice.address)
      const bobBefore = await tokenBalance(bob.address)

      console.log(`  Alice balance before: ${aliceBefore}`)
      console.log(`  Bob balance before:   ${bobBefore}`)

      // --- Bob's server: charges 0.001 SBC for access ---
      const bobServer = Mppx_server.create({
        methods: [
          radius_server.charge({
            getClient: () => bobClient,
            currency: token.address,
            decimals: token.decimals,
            account: bob,
          }),
        ],
        realm,
        secretKey,
      })

      const httpServer = await Http.createServer(async (req, res) => {
        const result = await Mppx_server.toNodeListener(
          bobServer.charge({
            amount: chargeAmount,
            decimals: token.decimals,
            currency: token.address,
            recipient: bob.address,
          }),
        )(req, res)

        if (result.status === 402) return

        // Payment verified — serve the protected resource.
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ data: 'premium-database-record-42' }))
      })

      // --- Alice's client ---
      const aliceMppx = Mppx_client.create({
        polyfill: false,
        methods: [
          radius_client({
            account: alice,
            mode: 'push',
            getClient: () => aliceClient,
          }),
        ],
      })

      // First request → 402 Payment Required → auto-pay → 200 OK.
      const response = await aliceMppx.fetch(httpServer.url)
      expect(response.status).toBe(200)

      // Verify receipt header.
      const receipt = Receipt.fromResponse(response)
      expect(receipt.method).toBe('radius')
      expect(receipt.status).toBe('success')
      expect(receipt.reference).toMatch(/^0x[0-9a-fA-F]{64}$/)
      logExplorerLinks('payment', receipt.reference)

      // Verify resource body.
      const body = await response.json()
      expect(body).toEqual({ data: 'premium-database-record-42' })

      // --- balances after ---
      const aliceAfter = await tokenBalance(alice.address)
      const bobAfter = await tokenBalance(bob.address)

      console.log(`  Alice balance after:  ${aliceAfter}`)
      console.log(`  Bob balance after:    ${bobAfter}`)

      // Alice spent at least the charge amount.
      expect(aliceBefore - aliceAfter).toBeGreaterThanOrEqual(chargeRaw)
      // Bob received exactly the charge amount.
      expect(bobAfter - bobBefore).toBe(chargeRaw)

      httpServer.close()
    })
  })

  // --------------------------------------------------------------------------
  // Test 2 — Round-trip transfer: Alice → Bob 0.001 SBC, Bob → Alice 0.001 SBC.
  //
  //   Alice sends 0.001 SBC to Bob via a standard ERC-20 transfer.
  //   Bob verifies receipt, then immediately transfers 0.001 SBC back to Alice.
  //   Net effect: both balances return to their starting values (minus gas).
  // --------------------------------------------------------------------------
  describe('round-trip: Alice pays Bob, Bob pays Alice back', () => {
    test('Alice → Bob → Alice each 0.001 SBC', async () => {
      const aliceBefore = await tokenBalance(alice.address)
      const bobBefore = await tokenBalance(bob.address)

      console.log(`  Alice balance before: ${aliceBefore}`)
      console.log(`  Bob balance before:   ${bobBefore}`)

      // ---- Step 1: Alice → Bob 0.001 SBC ----

      // Bob's server: accepts 0.001 SBC charge and returns tx hash.
      const bobServer = Mppx_server.create({
        methods: [
          radius_server.charge({
            getClient: () => bobClient,
            currency: token.address,
            decimals: token.decimals,
            account: bob,
          }),
        ],
        realm,
        secretKey,
      })

      let aliceToBobHash: string | undefined

      const httpServer = await Http.createServer(async (req, res) => {
        const result = await Mppx_server.toNodeListener(
          bobServer.charge({
            amount: chargeAmount,
            decimals: token.decimals,
            currency: token.address,
            recipient: bob.address,
          }),
        )(req, res)

        if (result.status === 402) return
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ ok: true }))
      })

      const aliceMppx = Mppx_client.create({
        polyfill: false,
        methods: [
          radius_client({
            account: alice,
            mode: 'push',
            getClient: () => aliceClient,
          }),
        ],
      })

      const response1 = await aliceMppx.fetch(httpServer.url)
      expect(response1.status).toBe(200)

      const receipt1 = Receipt.fromResponse(response1)
      expect(receipt1.method).toBe('radius')
      expect(receipt1.status).toBe('success')
      aliceToBobHash = receipt1.reference
      logExplorerLinks('Alice → Bob', aliceToBobHash)

      httpServer.close()

      // ---- Step 2: Bob → Alice 0.001 SBC ----

      // Alice's server: accepts 0.001 SBC charge from Bob.
      const aliceServer = Mppx_server.create({
        methods: [
          radius_server.charge({
            getClient: () => aliceClient,
            currency: token.address,
            decimals: token.decimals,
            account: alice,
          }),
        ],
        realm: 'alice-server.example',
        secretKey: 'alice-test-secret',
      })

      const httpServer2 = await Http.createServer(async (req, res) => {
        const result = await Mppx_server.toNodeListener(
          aliceServer.charge({
            amount: chargeAmount,
            decimals: token.decimals,
            currency: token.address,
            recipient: alice.address,
          }),
        )(req, res)

        if (result.status === 402) return
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ ok: true }))
      })

      const bobMppx = Mppx_client.create({
        polyfill: false,
        methods: [
          radius_client({
            account: bob,
            mode: 'push',
            getClient: () => bobClient,
          }),
        ],
      })

      const response2 = await bobMppx.fetch(httpServer2.url)
      expect(response2.status).toBe(200)

      const receipt2 = Receipt.fromResponse(response2)
      expect(receipt2.method).toBe('radius')
      expect(receipt2.status).toBe('success')
      logExplorerLinks('Bob → Alice', receipt2.reference)

      httpServer2.close()

      // ---- Verify balances ----

      const aliceAfter = await tokenBalance(alice.address)
      const bobAfter = await tokenBalance(bob.address)

      console.log(`  Alice balance after:  ${aliceAfter}`)
      console.log(`  Bob balance after:    ${bobAfter}`)

      // Both transferred 0.001 SBC to each other, so token balances should
      // be approximately the same as before (only gas costs differ).
      // For ERC-20 tokens (not native), the token balance change is exactly zero.
      if (token.address !== '0x0000000000000000000000000000000000000000') {
        // ERC-20: net token movement is zero (Alice sent 0.001, received 0.001).
        expect(aliceAfter).toBe(aliceBefore)
        expect(bobAfter).toBe(bobBefore)
      }

      console.log(`\n  Explorer links:`)
      console.log(`    Alice → Bob: ${txUrl(aliceToBobHash!)}`)
      console.log(`    Bob → Alice: ${txUrl(receipt2.reference)}`)
      console.log(`    Alice:       ${addressUrl(alice.address)}`)
      console.log(`    Bob:         ${addressUrl(bob.address)}`)
    })
  })
})
