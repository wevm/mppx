import { cloudflare } from '@cloudflare/vite-plugin'
import { defineConfig } from 'vite'

// Runs the Worker in workerd, the Cloudflare Workers runtime, with its
// .dev.vars, exactly as deployed. Vite serves the browser page.
export default defineConfig({
  plugins: [cloudflare()],
  server: { port: 8787 },
})
