import { cloudflare } from '@cloudflare/vite-plugin'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Runs the Worker (src/server.ts) in workerd with its Durable Object and .dev.vars,
// and serves the page (index.html, src/app) as static assets from the same origin.
// FORTUNE_LOCAL=1 runs without a Cloudflare login: no Workers AI binding, so the Worker
// uses ANTHROPIC_API_KEY or its built-in haiku.
export default defineConfig(({ command }) => ({
  plugins: [
    react(),
    cloudflare(
      command === 'serve' && process.env.FORTUNE_LOCAL
        ? { config: (config) => void delete (config as { ai?: unknown }).ai }
        : {},
    ),
  ],
  server: {
    port: 8790,
    allowedHosts: true,
    // Keep secrets off the dev server: Vite's defaults plus .dev.vars.
    fs: { deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '.dev.vars*'] },
  },
}))
