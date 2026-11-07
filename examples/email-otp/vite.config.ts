import { cloudflare } from '@cloudflare/vite-plugin'
import { defineConfig } from 'vite'

// Runs the Worker in workerd, the Cloudflare Workers runtime, with its
// Durable Objects and .dev.vars, exactly as deployed.
export default defineConfig({
  plugins: [cloudflare()],
  server: {
    port: 8788,
    // Keep secrets off the dev server: Vite's defaults plus .dev.vars.
    fs: { deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '.dev.vars*'] },
  },
})
