import { cloudflare } from '@cloudflare/vite-plugin'
import { defineConfig } from 'vite'

// Runs the Worker (src/server.ts) in workerd, the Cloudflare Workers runtime,
// with its Durable Objects and .dev.vars, exactly as deployed. The same server
// serves the page (index.html, src/client.ts) as static assets.
export default defineConfig({
  plugins: [cloudflare()],
  server: { port: 8787 },
})
