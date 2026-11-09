# Onchain KYC registry with MPP

A paid API on Cloudflare Workers that only KYC'd payers may use. The operator keeps the list of verified addresses in a contract, [`contracts/KycRegistry.sol`](./contracts/KycRegistry.sol). Before a payment settles, the server reads the registry for the payer's address: a listed payer pays and gets the report, any other payer gets `403` and its payment is never broadcast.

The client is a regular Mppx client. The registry is the proof, so there is nothing to prove on the client.

## Setup

You need [Foundry](https://getfoundry.sh) for the contract.

```bash
npx gitpick wevm/mppx/examples/onchain-kyc
pnpm i
```

Deploy the registry to Tempo testnet from an operator account funded with the testnet faucet:

```bash
export RPC=https://rpc.moderato.tempo.xyz
export OPERATOR_KEY=0x…   # cast wallet new, then fund it at the faucet
forge create contracts/KycRegistry.sol:KycRegistry --rpc-url $RPC --private-key $OPERATOR_KEY --broadcast
export KYC_REGISTRY=0x…   # "Deployed to"
REGISTRY=$KYC_REGISTRY pnpm keygen   # writes .dev.vars, funds the server account
```

## Usage

Start the Worker locally:

```bash
pnpm dev
```

In a separate terminal, run the client with a new account. The registry does not list it, so the paid retry gets `403`:

```bash
pnpm client
```

Add the account it printed, then run it again with its key. It pays 0.01 pathUSD and gets the report:

```bash
cast send $KYC_REGISTRY 'setVerified(address,bool)' 0x… true --rpc-url $RPC --private-key $OPERATOR_KEY
PRIVATE_KEY=0x… pnpm client
```

## Coinbase Verifications

To accept anyone with a [Coinbase Verified Account](https://github.com/coinbase/verifications) attestation on Base instead of your own list, set `COINBASE_VERIFIED=true` in `.dev.vars`. The server then uses:

```ts
const kyc = Onchain.Server.coinbase({
  client: createClient({ chain: base, transport: http() }),
})
```

The payer must pay from the address it verified with Coinbase.

## How it works

[`src/server.ts`](./src/server.ts) creates `Onchain.Server.registry({ client, registry })` and requires it as the route's payment check: `mppx.charge({ amount, identity: { payment: kyc } })`. Every `402` carries `Identity-Required: kyc;issuer="eip155:42431:<registry>"`, so clients can tell which list applies. On the paid retry the check reads the payer's address from the Credential's `source` and calls `isVerified(address)` on the registry:

| Registry answer  | Response                               |
| ---------------- | -------------------------------------- |
| Listed           | Payment settles, `200` with the report |
| Not listed       | `403`, payment not broadcast           |
| Read failed      | `503`, payment not broadcast           |
| No payer address | `401`, payment not broadcast           |

A payer cannot claim a listed address it does not control: after the check, the payment method rejects a Credential whose `source` is not the account that signed the payment. In a handler, `result.identity.get(kyc)` returns the allowed payer.

For a contract with a different interface, pass `read`:

```ts
Onchain.Server.registry({
  client,
  registry,
  read: ({ client, payer, registry }) =>
    readContract(client, { address: registry, abi, functionName: 'allowed', args: [payer] }),
})
```

The check reads the registry on every paid request, so removing an address takes effect on its next payment.
