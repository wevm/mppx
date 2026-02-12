# mpay

## 0.2.0

### Minor Changes

- 04df8d5: **Breaking:** Renamed `client` parameter to `getClient`.

  ```diff
  - tempo.charge({ client: (chainId) => createClient({ ... }) })
  + tempo.charge({ getClient: (chainId) => createClient({ ... }) })
  ```

- b72b6cd: Added framework middleware adapters for Hono, Express, Next.js, and Elysia.

  ```ts
  import { Mpay, tempo } from "mpay/hono";

  const mpay = Mpay.create({ methods: [tempo.charge()] });

  app.get("/premium", mpay.charge({ amount: "1" }), (c) =>
    c.json({ data: "paid content" })
  );
  ```

- 1f31b79: **Breaking:** Changed `getClient` interface to accept an object parameter.

  ```diff
  - getClient: (chainId: number) => Client
  + getClient: ({ chainId }: { chainId?: number | undefined }) => Client
  ```

- 3db4245: **Breaking:** Renamed `method` to `methods` on `Challenge.from()`, `Challenge.deserialize()`, `Challenge.fromHeaders()`, and `Challenge.fromResponse()`.

  ```diff
  - const challenge = Challenge.fromResponse(response, { method })
  + const challenge = Challenge.fromResponse(response, { methods })

  - const challenge = Challenge.deserialize(value, { method })
  + const challenge = Challenge.deserialize(value, { methods })
  ```

- 9d079e5: Added support for passing an `Account` as `recipient` to server-side `tempo.charge()` and `tempo.stream()`. When an `Account` is passed, its `address` is used as the payment recipient. Setting `feePayer: true` makes the recipient account also sponsor transaction fees.

  ```ts
  import { Mpay, tempo } from "mpay/server";

  const mpay = Mpay.create({
    methods: [
      tempo.charge({
        recipient: account,
        feePayer: true,
        currency: "0x...",
      }),
    ],
  });
  ```

- e773992: **Breaking:** Removed `Fetch` from the public API of `mpay/client`. `Mpay.create()` now returns a `fetch` function and polyfills `globalThis.fetch` by default.

  ```diff
  - import { Fetch, tempo } from 'mpay/client'
  + import { Mpay, tempo } from 'mpay/client'

  - Fetch.polyfill({
  + Mpay.create({
      methods: [tempo.charge({ account })],
    })

    // globalThis.fetch now handles 402 automatically
    const res = await fetch('/resource')

  - Fetch.restore()
  + Mpay.restore()
  ```

  To opt out of polyfilling, set `polyfill: false` and use the returned `fetch`:

  ```ts
  const mpay = Mpay.create({
    polyfill: false,
    methods: [tempo.charge({ account })],
  });

  const res = await mpay.fetch("/resource");
  ```

- 3db4245: **Breaking:** Removed `Method` module. Use `MethodIntent` instead.

  ```diff
  - import { Method } from 'mpay'
  + import { MethodIntent } from 'mpay'

  - const server = Method.toServer(method, { verify })
  + const server = MethodIntent.toServer(methodIntent, { verify })

  - const client = Method.toClient(method, { createCredential })
  + const client = MethodIntent.toClient(methodIntent, { createCredential })
  ```

- a335fda: **Breaking:** Renamed `recipient` parameter to `account`. The `recipient` parameter now only accepts an `Address` string (in cases where you want a separate recipient address).

  ```diff
  tempo.charge({
  -  recipient: account,
  +  account,
    feePayer: true,
    // or with different recipient address
    recipient: '0x...',
  })
  ```

- 1e47a09: **Breaking:** Refactored tempo method exports to use `tempo.charge()` namespace.

  ```diff
  import { Mpay, tempo } from 'mpay/server'

  const mpay = Mpay.create({
  -  methods: [tempo()],
  +  methods: [tempo.charge()],
  })
  ```

- df400e3: Added composed `tempo()` client factory that returns both `charge` and `stream` method intents.

  ```ts
  import { Mpay, tempo } from "mpay/client";

  const mpay = Mpay.create({
    methods: [tempo({ account, deposit: 10_000_000n })],
  });
  ```

  `tempo.charge()` and `tempo.stream()` continue to work for individual use. `Mpay.create` now accepts nested tuples in `methods` and flattens them automatically.

- 6c41693: Added `tempo.stream` intent.

### Patch Changes

- 10e9204: Added `Channel.computeId` to compute stream channel IDs locally, eliminating a network round-trip to the contract.
- aea84a3: Supported nested method tuples in server `Mpay.create`, matching the client-side `Methods` pattern. Methods are automatically flattened via `FlattenMethods`.
- a630f09: Added support for multiple `Authorization` schemes. `Credential.fromRequest` and the HTTP server transport now correctly extract the `Payment` scheme from headers containing multiple authorization values (e.g., `Bearer` alongside `Payment`).

## 0.1.0

### Minor Changes

- 233236d: Initial release.
