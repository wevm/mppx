import type { z } from 'zod/mini'

import type { Methods } from '../../../stripe/index.js'
import type { HtmlConfig } from '../../../stripe/server/Charge.js'

declare global {
  interface MppxChallengeRequest extends z.output<typeof Methods.charge.schema.request> {}
  interface MppxConfig extends HtmlConfig {}
}
