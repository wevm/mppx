# Contract-qualified preparePayment

An application example that qualifies an exact HTTP request and a bounded OpenAPI 3.1 success contract before calling the exported preparePayment().createCredential() path.

## Official seam

Use the real exported path:

1. rawFetch(frozen request)
2. preparePayment(response, { request })
3. inspect the immutable selected challenge
4. qualify the request and OpenAPI 3.1 contract
5. createCredential()
6. setCredential(exact request, result)
7. stop. Do not send the authenticated request.

Use Mppx.create().preparePayment(). A fake fetch may be injected with
polyfill: false so rawFetch never hits a network.

## Buyer-side binding, not MPP HTTP binding

MPP binds the selected challenge fields only. MPP does not
cryptographically bind the HTTP method, path, query, or output contract.

This example records local authorization evidence for:

- the exact uppercase HTTP method
- the byte-exact absolute URL, including query order
- the inspected challenge id plus amount, currency, and any present
  chain / network / recipient terms
- the SHA-256 digest of the frozen OpenAPI document bytes
- the exact operation, successful status, media type, and schema pointer
- the buyer-required output paths

It does not read `_mppx_scope`, `opaque`, or any other server-private field.

## Fail-closed OpenAPI 3.1 qualifier

The qualifier accepts only directly represented OpenAPI 3.1 forms it can prove.
It rejects, and must not sign, when it sees:

- openapi other than 3.1.x, or an unknown jsonSchemaDialect
- dollar-ref, including dynamic or recursive refs
- composition (allOf, oneOf, anyOf, not)
- more than one applicable 2xx status or success media type
- a media type other than application/json
- path templating or a non-unique path/method pair
- a missing buyer-required output path
- another unsupported schema representation

The extract fixture is modeled on a live zero-spend probe of GET /extract?url=https%3A%2F%2Fexample.com.
It uses one evm/charge offer and a JSON 200 schema that requires ok, url, and title.

## Running

The oracle is `src/client/prepared-payment.example.test.ts`.

`pnpm dev` only runs the local fake 402 demo that stops after attachment.
No wallet. No network.
