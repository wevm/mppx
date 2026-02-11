import { openai, Proxy } from 'mpay/proxy'
import { Mpay, tempo } from 'mpay/server'

const mpay = Mpay.create({ methods: [tempo()] })

const proxy = Proxy.create({
  services: [
    openai({
      apiKey: 'sk-...',
      routes: {
        'GET /v1/models': mpay.charge({ amount: '1' }),
      },
    }),
  ],
})

// Usage
createServer(proxy.listener) // Node.js
Bun.serve(proxy) // Bun
Deno.serve(proxy) // Deno
app.all('*', (c) => proxy.fetch(c.request)) // Elysia
app.use(proxy.listener) // Express
app.use((c) => proxy.fetch(c.req.raw)) // Hono
export const GET = proxy.fetch // Next.js
export const POST = proxy.fetch // Next.js
