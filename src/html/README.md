# `mppx/html`

Public HTML payment-page API for `mppx`.

This directory has three public entrypoints:

- `mppx/html` — browser helpers like `mount`, plus shared `classNames`/`elements`.
- `mppx/html/vite` — Vite plugin for developing and building HTML payment pages.
- `mppx/html/env` — ambient browser types for the global `mppx` runtime.

## End-to-End Flow

1. A server method exposes `html.content`.
2. Your app runs the normal payment handler for the protected route.
3. On a 402 response, if the request accepts HTML (`Accept: text/html`), mppx renders the page shell, embeds the challenge/config JSON, and serves any HTML infrastructure requests via reserved query params on that same route.
4. In the browser, your page code reads `mppx.challenge` / `mppx.config`, collects payment proof, then calls `mppx.dispatch(...)`.
5. The browser page shell verifies the payment and reloads the page with the credential attached.

## Server Usage

HTML rendering is configured per server method via its `html` option. `Transport.http()` always uses the built-in page shell when a method provides HTML content.

```ts
import { Mppx, tempo } from 'mppx/server'

const mppx = Mppx.create({
  methods: [
    tempo.charge({
      currency: '0x20c0000000000000000000000000000000000000',
      recipient: '0x0000000000000000000000000000000000000001',
      html: {},
    }),
  ],
})

export async function handler(request: Request) {
  const result = await mppx.charge({ amount: '1' })(request)
  if (result.status === 402) return result.challenge

  return result.withReceipt(Response.json({ ok: true }))
}
```

If HTML is enabled, expose the protected route on a handler that accepts both `GET` and `POST`. Built-in browser actions are served from the same route via reserved query params.

### Built-In Method Variants

Tempo enables the built-in HTML page with the same `html: { ... }` object shape as other methods:

```ts
tempo.charge({
  currency: '0x20c0000000000000000000000000000000000000',
  recipient: '0x0000000000000000000000000000000000000001',
  html: {
    text: { title: 'Complete payment' },
  },
})
```

Stripe enables the built-in HTML page with client config:

```ts
stripe.charge({
  secretKey: process.env.STRIPE_SECRET_KEY!,
  currency: 'usd',
  networkId: 'internal',
  paymentMethodTypes: ['card'],
  html: {
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY!,
    theme: {
      accent: ['#111111', '#f5f5f5'],
    },
  },
})
```

## Custom Server Method HTML

Custom methods attach HTML through the `html` namespace on `Method.toServer(...)`.

```ts
import { Method } from 'mppx'
import * as Methods from './Methods.js'
import { html } from './html.gen.js'

const charge = Method.toServer(Methods.charge, {
  html: {
    actions: {
      issueToken: async (request) => {
        return new Response('ok')
      },
    },
    content: html,
    config: {
      issuer: 'example-payments',
    },
    text: {
      title: 'Complete payment',
    },
    theme: {
      accent: ['#111111', '#f5f5f5'],
    },
  },
  async verify({ credential }) {
    return {
      method: 'example',
      status: 'success',
      timestamp: new Date().toISOString(),
      reference: credential.challenge.id,
    }
  },
})
```

`html` supports:

- `actions` — route-local browser actions exposed on `mppx.config.<actionName>`.
- `content` — the method HTML fragment to render inside the shared page shell.
- `config` — method-specific browser config, available as `mppx.config`.
- `text` — shell copy overrides.
- `theme` — shell theme overrides.

## Browser Runtime

The payment page shell exposes a global `mppx` object:

```ts
type Mppx = {
  readonly challenge: Challenge
  readonly challenges: Readonly<Record<string, Challenge>> | undefined
  readonly config: Record<string, unknown>
  dispatch(payload: unknown, source?: string): void
  serializeCredential(payload: unknown, source?: string): string
}
```

Use `dispatch(...)` when you want the standard page flow.

Use `serializeCredential(...)` when you need the encoded `Authorization: Payment ...` value but want to send it yourself.

### Recommended: `mount(...)`

`mount(...)` is the easiest way to build a method UI. It gives you a scoped root, the typed challenge/config, a few shell helpers, and stable method-local values in composed pages.

```ts
import { mount } from 'mppx/html'

mount((c) => {
  c.set('amount', '$10.00')

  const button = document.createElement('button')
  button.className = c.classNames.button
  button.textContent = 'Pay'
  button.onclick = () => {
    c.dispatch({ token: 'payment-proof' })
  }

  c.root.appendChild(button)
})
```

`mount(...)` provides:

- `root` — root element for this method instance.
- `challenge` — parsed challenge for this method.
- `challenges` — all challenges in composed pages.
- `config` — method config from the server.
- `dispatch(...)` — submit a credential.
- `serializeCredential(...)` — encode a credential without dispatching.
- `set(name, value)` — update shell UI state like the header amount.
- `classNames` — shell CSS class names for consistent styling.

### Without `mount(...)`

You can use the global runtime directly if you want full control.

```ts
import { classNames, elements } from 'mppx/html'

const root = document.getElementById(elements.method)!
const challenge = mppx.challenge
const config = mppx.config

const button = document.createElement('button')
button.className = classNames.button
button.textContent = `Pay ${challenge.request.amount}`
button.onclick = () => {
  mppx.dispatch({ token: `signed-for-${config.networkId}` })
}

root.appendChild(button)
```

If you skip `mount(...)`, it is best to snapshot `mppx.challenge` / `mppx.config` during setup instead of repeatedly reading them later. That matters most for composed pages, where the active method changes as tabs change.

## Typing Options

You have two ways to type browser code.

### Option 1: `mount` Generics

Best when you want local, explicit types and no global augmentation.

```ts
import type { Methods } from 'mppx/tempo'
import { mount } from 'mppx/html'

type Config = {
  rpcUrl: string
}

mount<typeof Methods.charge, Config>((c) => {
  c.challenge.request.amount
  c.config.rpcUrl
})
```

### Option 2: Global `mppx` Types via `mppx/html/env`

Best when you want to use the global `mppx` object directly.

Create a local `env.d.ts` in your HTML app:

```ts
/// <reference types="mppx/html/env" />

declare global {
  interface MppxChallengeRequest {
    amount: string
    currency: string
  }

  interface MppxConfig {
    createToken?: string
    publishableKey: string
  }
}

export {}
```

Then browser code can use typed globals:

```ts
const amount = mppx.challenge.request.amount
const tokenUrl = mppx.config.createToken
```

## Vite Authoring

`mppx/html/vite` is the recommended way to build method HTML.

```ts
import { defineConfig } from 'vite'

import { Methods } from 'mppx/tempo'
import mppx from 'mppx/html/vite'

export default defineConfig({
  plugins: [
    mppx({
      method: Methods.charge,
      output: '../../tempo/server/internal/html.gen.ts',
      challenge: {
        request: {
          amount: '1',
          currency: '0x20c0000000000000000000000000000000000000',
          decimals: 6,
          recipient: '0x0000000000000000000000000000000000000001',
        },
        description: 'Test payment',
      },
      config: {
        rpcUrl: 'https://rpc.example.com',
      },
      html: {
        text: { title: 'Pay now' },
      },
    }),
  ],
})
```

Plugin options:

- `method` — the method schema used by the page.
- `entry` — optional entry basename. Defaults to `method.intent`, but you can point to files like `src/form.ts` and `src/form.html` with `entry: 'form'`.
- `output` — file path for the generated `html.gen.ts` module.
- `challenge` — dev-only challenge fixture. `challenge.request` is required in dev.
- `config` — method config exposed to the browser as `mppx.config`.
- `html` — shell text/theme configuration for dev.
- `realm` — dev challenge realm.
- `secretKey` — dev HMAC secret for challenge IDs.

`output` is a file path, not a directory, because the plugin emits a single self-contained module. Imported method CSS is folded into that generated file during build.

Expected app files:

- `src/<entry>.ts` — optional browser entry, for example `src/charge.ts` or `src/form.ts`.
- `src/<entry>.html` — optional HTML fragment inserted before the module script.

At least one of `src/<entry>.ts` or `src/<entry>.html` is required. You only need both when you want both markup and browser logic. When `entry` is omitted, `<entry>` defaults to `method.intent`.

Method-specific CSS can live in a normal stylesheet file and be imported from `src/<entry>.ts`:

```ts
import './charge.css'
import { mount } from 'mppx/html'

mount((c) => {
  c.root.textContent = 'Ready to pay'
})
```

In dev, Vite serves that CSS with HMR. In production, `mppx/html/vite` inlines the built CSS into the generated `html.gen.ts`.

Build output:

- production build inlines your method code and imported CSS into `html.gen.ts`
- dev serves the same page shell with Vite HMR

## Compose Pages

When the server uses `mppx.compose(...)`, the shell renders tabs for each payment method.

In composed pages:

- `mount(...)` scopes `root`, `challenge`, and `config` to the method instance being mounted.
- `mppx.challenges` contains all challenges keyed by `name/intent`.
- the active tab is also reflected in the URL with `mppx_method=...`.

If you use `mount(...)`, you usually do not need any compose-specific logic.

## Shared Styling Hooks

`mppx/html` exports shared class names and element IDs:

```ts
import { classNames, elements } from 'mppx/html'
```

Use them when you want your custom UI to match the shell styling or target shell elements without hard-coding strings.

## Good Defaults

- Prefer `mount(...)` unless you have a strong reason not to.
- Use `mppx/html/vite` for authoring instead of hand-building HTML strings.
- Use `mppx/html/env` only when you want typed global access to `mppx`.
- Keep custom HTML helpers under `html.actions` so route-local browser support stays declarative.
