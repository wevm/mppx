# Tempo Sessions design

Tempo Sessions implements TIP-1034 payment channels for repeated HTTP and
streaming payments. A session is a channel, not an application login session.

A payer authorizes a cumulative amount with a signed voucher. The server
accepts that authorization, records delivered spend, and settles on-chain under
server-owned policy.

## Design principles

1. A channel has distinct on-chain, server, and client state. No copy replaces
   another authority.
2. Vouchers authorize value; server accounting records delivered value; chain
   settlement captures value. These are separate operations.
3. The server atomically accepts vouchers and records charges. Multiple server
   instances share one linearizable channel store.
4. Client persistence and server snapshots accelerate recovery. Neither is
   proof of a reusable channel until cryptographic and chain validation pass.
5. Management credentials never invoke application content handlers.
6. Settlement policy belongs to the server. A client authorizes value but does
   not choose when it is settled.

```mermaid
flowchart LR
  client["Client"]
  cache["Client ChannelStore\nrecovery cache"]
  server["Server session method\nverification and accounting"]
  ledger["Server AtomicStore\naccepted vouchers and spend"]
  chain["Tempo escrow precompile\ndeposit, settlement, close state"]

  client <--> cache
  client -->|"transactions and vouchers"| server
  client -->|"channel state reads"| chain
  server <--> ledger
  server -->|"validates, funds, settles"| chain
```

## Authority model

| State                              | Meaning                                                                               | Authority                                                                           |
| ---------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Channel descriptor and `channelId` | Immutable payer, payee, token, signer, operator, nonce, and salt identity.            | Derived from descriptor, chain ID, and escrow address. Every boundary validates it. |
| On-chain channel state             | Deposit, settled amount, and close state.                                             | Tempo escrow precompile.                                                            |
| Signed voucher                     | Payer authorization of a cumulative amount for one channel.                           | Client signer; server verifies before accepting.                                    |
| Server channel record              | Highest accepted signed voucher, delivered `spent`, `units`, and settlement progress. | Server `AtomicStore`.                                                               |
| Client channel entry               | Latest locally usable channel descriptor, deposit, and cumulative authorization.      | Client `ChannelStore`; a cache.                                                     |
| `SessionSnapshot`                  | Server-provided recovery hint.                                                        | Untrusted until client validation.                                                  |

The amounts below have intentionally different meanings.

| Amount                                        | Meaning                                      | Rule                                                     |
| --------------------------------------------- | -------------------------------------------- | -------------------------------------------------------- |
| `acceptedCumulative` / `highestVoucherAmount` | Highest voucher the server accepted.         | Never decreases.                                         |
| `spent`                                       | Value charged for content.                   | Never decreases; does not exceed accepted authorization. |
| `settled` / `settledOnChain`                  | Value captured by escrow.                    | Never decreases; chain-authoritative.                    |
| `requiredCumulative`                          | Authorization required for the next request. | It is a boundary, not a signed voucher.                  |

## Request lifecycle

The session method owns payment control flow. The route handler owns content.

```mermaid
sequenceDiagram
  participant C as Client
  participant S as Server session
  participant L as AtomicStore
  participant T as Tempo chain
  participant H as Route handler

  C->>S: protected request
  S-->>C: 402 session challenge
  C->>S: open or voucher credential
  S->>T: validate channel state; broadcast management transaction when needed
  S->>L: atomically accept voucher and record channel state
  S->>L: charge billable HTTP content
  S->>H: invoke only for a content credential
  H-->>C: response with Payment-Receipt
```

`open` and `voucher` credentials may pay for a billable request. `topUp` and
`close` are management credentials: they return `204` and never invoke the
route handler. `open` and `voucher` used on non-billable requests are also
management updates.

The current HTTP contract is deliberately pre-handler: voucher acceptance and
default request charging occur before the handler runs. A handler failure can
therefore follow an accepted voucher and recorded `spent`. Sessions does not
promise an atomic “charge only after a successful handler” transaction.

Applications with irreversible work define their own idempotency and failure
behavior. SDK changes must preserve this boundary or introduce an explicit
prepare/commit contract rather than changing it implicitly.

## Recovery lifecycle

The application owns durable mapping from its authenticated request identity to
a channel ID. The SDK owns channel lookup, snapshot construction, and recovery
validation.

`resolveChannelId` is the only application-defined recovery boundary. It maps a
verified request identity to an existing channel ID. It does not authorize a
channel, recreate accounting, or trust a client-provided channel ID.

### Bootstrap configuration

Enable `bootstrap` when a client should recover an existing channel before its
first paid request:

```ts
tempo.session({
  bootstrap: true,
  resolveChannelId({ source, paymentRequest }) {
    return db.findChannelId({
      payer: parseSource(source),
      payee: paymentRequest.recipient,
      token: paymentRequest.currency,
      // Include chain and escrow when the application supports more than one.
    })
  },
})
```

The hook resolves application identity and payment scope. The channel store
loads the returned primary key only; MPPx does not scan the store or define a
secondary-index format. If the request supplies a channel ID, MPPx uses it and
does not call the hook.

```mermaid
sequenceDiagram
  participant C as Cold client
  participant S as Server session
  participant R as resolveChannelId
  participant L as AtomicStore
  participant T as Tempo chain

  C->>S: HEAD protected resource
  S-->>C: 402 zero-amount identity challenge
  C->>S: HEAD with signed proof
  S->>S: verify proof and recover source
  S->>R: resolve source and payment scope to channelId
  R-->>S: channelId or no result
  S->>L: load compatible channel record
  S->>S: validate chain, token, escrow, payee, and signed voucher
  S-->>C: 204 with session snapshot when available
  C->>T: read live channel state
  C->>C: validate descriptor, signer, voucher, and state
  C->>C: hydrate Client ChannelStore
```

A snapshot is never authorization. Before caching it, the client validates the
descriptor-derived ID, payer, authorized signer, signed voucher when present,
and live on-chain state. A snapshot that lacks a usable signed voucher cannot
create higher client authorization; the client reuses persisted state or opens
a channel instead.

## Streaming lifecycle

SSE and WebSocket are stream-metered. They do not reuse normal HTTP response
accounting. The server emits a voucher boundary as content is consumed; the
client submits the next signed cumulative voucher; the server accepts it and
emits a receipt before content continues.

```mermaid
sequenceDiagram
  participant S as Metered server stream
  participant C as Client transport driver
  participant L as AtomicStore

  S->>C: content
  S->>C: need-voucher(requiredCumulative)
  C->>C: enforce max deposit; top up when required
  C->>S: signed voucher
  S->>L: atomically accept voucher
  S->>C: receipt
  S->>C: continue content
```

The initial SSE POST is excluded from default HTTP charging to prevent double
counting. Stream accounting remains owned by the transport driver.

## Extension boundaries

| Change                         | Preserve                                                                                        |
| ------------------------------ | ----------------------------------------------------------------------------------------------- |
| Credential action or payload   | Descriptor validation, source binding, action gate, receipt semantics, and atomic store update. |
| Voucher or accounting rule     | Monotonic accepted/spent/settled values and linearizable updates.                               |
| Client planning or persistence | Channel scope key, recovery validation, max-deposit enforcement, and manual context behavior.   |
| Bootstrap or snapshot          | `resolveChannelId` ownership and client-side validation before cache hydration.                 |
| SSE or WebSocket transport     | Transport-owned metering and receipt coordination; no HTTP double charge.                       |

The module boundaries implement these contracts:

| Module                                                          | Responsibility                                                                |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `precompile/`                                                   | Channel identity, chain calls, vouchers, and wire primitives.                 |
| `client/CredentialState.ts` and `client/ChannelOps.ts`          | Credential planning, recovery validation, and client cache updates.           |
| `server/CredentialVerification.ts` and `server/ChannelStore.ts` | Credential verification and authoritative atomic channel state.               |
| `server/Settlement.ts`                                          | Content accounting and server-owned settlement cadence.                       |
| `server/RequestState.ts`                                        | Challenge context, bootstrap identity lookup, snapshots, and response gating. |
| `client/Transports.ts` and `server/Transports.ts`               | SSE and WebSocket payment control messages.                                   |
