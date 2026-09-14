import { Cli, z } from 'incur'

import { validate as validateCore, validateStream } from '../../validation/core.js'
import { isAgentEnvironment, pc } from '../utils.js'
import type { Counts } from './helpers.js'
import { printResults, printSection } from './helpers.js'
import { missingDiscoverySuggestion } from './messages.js'

const validate = Cli.create('validate', {
  description: 'Validate an MPP server implementation end-to-end',
  args: z.object({
    url: z.string().describe('Base URL of the MPP server to validate'),
  }),
  options: z.object({
    endpoint: z.string().optional().describe('Endpoint to test (METHOD:path). Skips discovery.'),
    body: z
      .string()
      .optional()
      .describe(
        'Request body. With --endpoint, used directly. In discovery mode, JSON with / keys is a per-path mapping.',
      ),
    query: z.array(z.string()).optional().describe('Query parameter (key=value, repeatable)'),
    header: z.array(z.string()).optional().describe('Request header (key:value, repeatable)'),
    verbose: z.number().default(0).meta({ count: true }).describe('Verbosity level'),
    yes: z.boolean().default(false).describe('Auto-approve mainnet payments'),
    outputJson: z
      .boolean()
      .default(false)
      .describe('Output results as JSON (auto-enabled in known agent environments)'),
  }),
  alias: {
    endpoint: 'e',
    header: 'H',
    verbose: 'v',
    yes: 'y',
    outputJson: 'j',
  },
  async run(c) {
    const outputJson = c.options.outputJson || isAgentEnvironment()

    // JSON mode: batch everything
    if (outputJson) {
      const result = await validateCore({
        url: c.args.url,
        endpoint: c.options.endpoint,
        body: c.options.body,
        query: c.options.query,
        headers: c.options.header,
        verbose: c.options.verbose > 0,
        yes: c.options.yes,
        interactive: false,
      })
      console.log(JSON.stringify(result, null, 2))
      const noEndpoints = result.endpoints.length === 0 && !c.options.endpoint
      if (result.summary.failed > 0 || !result.discovery.found || noEndpoints) process.exit(1)
      return
    }

    // Streaming human-readable output
    const baseUrl = c.args.url.replace(/\/$/, '').replace(/\/openapi\.json$/i, '')
    console.log(`\n${pc.bold('mppx validate')} ${pc.dim(baseUrl)}\n`)

    const counts: Counts = { passed: 0, failed: 0, warnings: 0, suggested: 0, skipped: 0 }
    let sawMppEndpoint = false
    let sawNonMppPaymentEndpoint = false
    let sawMalformedChallenge = false
    let sawTestnet = false
    let sawMainnet = false
    let paymentSucceeded = false
    let discoveryFound = false
    let endpointCount = 0

    for await (const event of validateStream({
      url: c.args.url,
      endpoint: c.options.endpoint,
      body: c.options.body,
      query: c.options.query,
      headers: c.options.header,
      verbose: c.options.verbose > 0,
      yes: c.options.yes,
      interactive: !!process.stdin.isTTY,
      onPaymentResults: (results) => printResults(results, counts),
    })) {
      switch (event.phase) {
        case 'discovery':
          printSection('Discovery (/openapi.json)')
          printResults(event.results, counts)
          discoveryFound = event.discovery.found
          if (!discoveryFound && !c.options.endpoint) {
            console.log('')
            const [headline, ...lines] = missingDiscoverySuggestion.split('\n')
            console.log(pc.yellow(`  ${headline}`))
            for (const line of lines) console.log(line ? pc.dim(`  ${line}`) : '')
            console.log('')
            process.exit(1)
          }
          if (event.discovery.endpoints.length === 0 && !c.options.endpoint && discoveryFound) {
            console.log(pc.dim('  Use --endpoint to specify endpoints manually.'))
            console.log('')
            process.exit(1)
          }
          break
        case 'endpoint':
          endpointCount++
          printSection(`${event.endpoint.method} ${event.endpoint.path}`)
          break
        case 'challenge':
          console.log(pc.dim('  Challenge'))
          printResults(event.results, counts)
          if (event.isMpp) {
            sawMppEndpoint = true
            if (event.isTestnet) sawTestnet = true
            if (event.isMainnet) sawMainnet = true
          }
          if (event.isNonMppPayment) sawNonMppPaymentEndpoint = true
          if (event.isMalformedChallenge) sawMalformedChallenge = true
          break
        case 'errorHandling':
          console.log(pc.dim('  Error Handling'))
          printResults(event.results, counts)
          break
        case 'payment':
          if (event.succeeded) paymentSucceeded = true
          break
      }
    }

    // Summary
    printSummary(
      counts,
      {
        sawMppEndpoint,
        sawNonMppPaymentEndpoint,
        sawMalformedChallenge,
        sawTestnet,
        sawMainnet,
        paymentSucceeded,
      },
      endpointCount,
    )
  },
})

export default validate

function printSummary(
  counts: Counts,
  flags: {
    sawMppEndpoint: boolean
    sawNonMppPaymentEndpoint: boolean
    sawMalformedChallenge: boolean
    sawTestnet: boolean
    sawMainnet: boolean
    paymentSucceeded: boolean
  },
  endpointsLength: number,
): void {
  if (!flags.sawMppEndpoint && endpointsLength > 0) {
    console.log('')
    if (flags.sawMalformedChallenge) {
      console.log(
        pc.yellow(
          `  Payment scheme detected but challenge format is invalid on ${endpointsLength} endpoint(s).`,
        ),
      )
      console.log(
        pc.dim(
          '  The server uses WWW-Authenticate: Payment but the challenge parameters do not conform to MPP.',
        ),
      )
      console.log(
        pc.dim(
          '  Fix: encode payment details as base64url JSON in a request="..." parameter. See errors above.',
        ),
      )
    } else if (flags.sawNonMppPaymentEndpoint) {
      console.log(
        pc.yellow(
          `  No MPP endpoints found. Tested ${endpointsLength} endpoint(s) but none use WWW-Authenticate: Payment.`,
        ),
      )
      console.log(pc.dim('  This server may use x402 or another payment protocol.'))
    } else if (counts.skipped > 0 && counts.failed === 0) {
      console.log(
        pc.yellow(`  Could not reach payment gate on any endpoint (all returned 401/403/200).`),
      )
      console.log(
        pc.dim(
          '  The server may require authentication before payment. Try providing auth or use --endpoint with a public path.',
        ),
      )
    } else {
      console.log(
        pc.yellow(
          `  No MPP endpoints found. Tested ${endpointsLength} endpoint(s) but none use WWW-Authenticate: Payment.`,
        ),
      )
      console.log(pc.dim('  This server may use x402 or another payment protocol.'))
    }
    console.log('')
    process.exit(1)
  }

  console.log('')
  const parts: string[] = []
  if (counts.passed > 0) parts.push(pc.green(`${counts.passed} passed`))
  if (counts.failed > 0) parts.push(pc.red(`${counts.failed} failed`))
  if (counts.warnings > 0) parts.push(pc.yellow(`${counts.warnings} warning(s)`))
  if (counts.suggested > 0) parts.push(pc.cyan(`${counts.suggested} suggested`))
  if (counts.skipped > 0) parts.push(pc.yellow(`${counts.skipped} skipped`))
  console.log(`${pc.bold('Summary:')} ${parts.join(', ')}`)

  if (flags.paymentSucceeded && flags.sawTestnet && !flags.sawMainnet) {
    console.log('')
    console.log(
      pc.dim('  Tip: also validate your mainnet server to confirm real payments work end-to-end.'),
    )
  } else if (flags.sawMainnet && !flags.sawTestnet) {
    console.log('')
    console.log(
      pc.dim(
        '  Tip: also validate your testnet server for free. This CLI automatically provisions and funds a testnet wallet for testing.',
      ),
    )
  }

  console.log('')

  if (counts.failed > 0) process.exit(1)
}
