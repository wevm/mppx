export { resolveAccount } from './account.js'

import type * as Mppx from '../client/Mppx.js'
import type { Plugin } from './plugins/plugin.js'

/**
 * Define mppx configuration file
 *
 * @example Add plugins for more custom logging/handling (default: [tempo(), stripe(), evm()])
 * ```ts
 * // mppx.config.ts
 * import { defineConfig } from 'mppx/cli'
 * import { tempo } from 'mppx/cli/plugins'
 *
 * export default defineConfig({
 *   plugins: [tempo()],
 * })
 * ```
 *
 * @example Add client methods to extend mppx support (e.g. third-party mppx packages)
 * ```ts
 * // mppx.config.ts
 * import { defineConfig, resolveAccount } from 'mppx/cli'
 * import { tempo } from 'mppx/client'
 *
 * export default defineConfig({
 *   methods: [tempo({ account: await resolveAccount() })],
 * })
 * ```
 */
export function defineConfig<const methods extends Mppx.Methods | undefined = undefined>(
  config: defineConfig.Config<methods>,
): defineConfig.Config<methods> {
  return config
}

export declare namespace defineConfig {
  type Config<methods extends Mppx.Methods | undefined = undefined> = {
    /** Array of methods to use. */
    methods?: methods
    /** Optional payment preferences for configured client methods. */
    paymentPreferences?: methods extends Mppx.Methods
      ? Mppx.create.Config<methods>['paymentPreferences']
      : undefined
    /** Array of plugins to use. */
    plugins?: Plugin[] | undefined
  }
}

export type Config = defineConfig.Config<Mppx.Methods>
