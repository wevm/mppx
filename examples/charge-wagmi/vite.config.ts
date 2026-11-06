import { cloudflare } from '@cloudflare/vite-plugin'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Serves the React page and runs the Worker (server.ts) in workerd, the
// Cloudflare Workers runtime, with its Durable Objects and .dev.vars, exactly
// as deployed.
export default defineConfig({
  plugins: [react(), cloudflare()],
  server: { port: 8787 },
})
