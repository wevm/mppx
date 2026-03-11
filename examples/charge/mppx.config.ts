import { defineConfig, resolveAccount } from 'mppx/cli'
import { tempo } from 'mppx/client'

export default defineConfig({
  methods: [tempo({ account: await resolveAccount() })],
})
