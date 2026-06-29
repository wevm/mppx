import { Cli, z } from 'incur'

import { validate as validateDiscovery } from '../../discovery/Validate.js'
import { pc } from '../utils.js'
import { validateChallenge, validateErrorHandling } from './challenge.js'
import { extractEndpointsFromDiscovery, extractRequestBodyFromDiscovery, fetchDiscoveryDoc } from './discovery.js'
import { check, fail, parseEndpointArg, printCheck, printResults, printSection, resolveBodyForEndpoint, warn } from './helpers.js'
import type { Counts, EndpointSpec } from './helpers.js'
import { validatePaymentFlow } from './payment.js'

const validate = Cli.create('validate', {
  description: 'Validate an MPP server implementation end-to-end',
  args: z.object({
    url: z.string().describe('Base URL of the MPP server to validate'),
  }),
  options: z.object({
    endpoint: z.string().optional().describe('Endpoint to test (METHOD:path). Skips discovery.'),
    body: z.string().optional().describe('Request body. With --endpoint, used directly. In discovery mode, JSON with / keys is a per-path mapping.'),
    query: z.array(z.string()).optional().describe('Query parameter (key=value, repeatable)'),
    verbose: z
      .number()
      .default(0)
      .meta({ count: true })
      .describe('Verbosity level'),
    yes: z.boolean().default(false).describe('Auto-approve mainnet payments'),
  }),
  alias: {
    endpoint: 'e',
    verbose: 'v',
    yes: 'y',
  },
  async run(c) {
    const baseUrl = c.args.url.replace(/\/$/, '').replace(/\/openapi\.json$/i, '')
    const verbose = c.options.verbose > 0
    const counts: Counts = { passed: 0, failed: 0, warnings: 0, skipped: 0 }

    console.log(`\n${pc.bold('mppx validate')} ${pc.dim(baseUrl)}\n`)

    const { endpoints, discoveryDoc, shouldExit } = await discoverEndpoints(baseUrl, c.options, counts)
    if (shouldExit) process.exit(1)
    const flags = await validateEndpoints(baseUrl, endpoints, discoveryDoc, counts, {
      verbose,
      endpoint: c.options.endpoint,
      body: c.options.body,
      query: c.options.query,
      yes: c.options.yes,
    })
    printSummary(counts, flags, endpoints.length)
  },
})

export default validate

// Each stage of validation is defined in its own function below.

async function discoverEndpoints(
  baseUrl: string,
  options: { endpoint?: string | undefined; body?: string | undefined; query?: string[] | undefined; verbose: number; yes: boolean },
  counts: Counts,
): Promise<{ endpoints: EndpointSpec[]; discoveryDoc: Record<string, unknown> | null; shouldExit?: boolean }> {
  let endpoints: EndpointSpec[] = []
  let discoveryDoc: Record<string, unknown> | null = null

  printSection('Discovery (/openapi.json)')
  const discoveryResult = await fetchDiscoveryDoc(baseUrl)

  if ('error' in discoveryResult) {
    printCheck(fail('Document found', discoveryResult.error, 'MPP servers must serve an OpenAPI document at /openapi.json with x-payment-info extensions.'))
    counts.failed++
    if (!options.endpoint) {
      console.log('')
      console.log(pc.yellow('  No discovery document found.'))
      console.log(pc.dim('  MPP servers must serve an OpenAPI document at /openapi.json with x-payment-info extensions.'))
      console.log(pc.dim('  To test a specific endpoint: mppx validate <url> --endpoint POST:/your/path'))
      console.log('')
      return { endpoints, discoveryDoc, shouldExit: true }
    }
  } else {
    printCheck(check('Document found and parseable'))
    counts.passed++

    const issues = validateDiscovery(discoveryResult.doc)
    const errors = issues.filter((i) => i.severity === 'error')
    const warnings = issues.filter((i) => i.severity === 'warning')

    if (errors.length > 0) {
      printCheck(fail('Valid OpenAPI structure', `${errors.length} error(s)`))
      counts.failed++
      for (const issue of errors) {
        console.log(pc.dim(`    ${issue.path}: ${issue.message}`))
      }
    } else {
      printCheck(check('Valid OpenAPI structure'))
      counts.passed++
    }

    for (const w of warnings) {
      printCheck(warn(w.message, w.path))
      counts.warnings++
    }

    discoveryDoc = discoveryResult.doc as Record<string, unknown>
  }

  // Resolve endpoints: --endpoint overrides discovery
  if (options.endpoint) {
    const parsed = parseEndpointArg(options.endpoint)
    if (!parsed) {
      console.log(pc.red(`Invalid endpoint format: "${options.endpoint}". Use METHOD:path (e.g. GET:/api/data)`))
      return { endpoints, discoveryDoc, shouldExit: true }
    }
    endpoints.push(parsed)
  } else if (discoveryDoc) {
    endpoints = extractEndpointsFromDiscovery(discoveryDoc)

    const NO_AMOUNT = BigInt('999999999999999999')
    endpoints.sort((a, b) => {
      const aAmt = a.amount ? BigInt(a.amount) : NO_AMOUNT
      const bAmt = b.amount ? BigInt(b.amount) : NO_AMOUNT
      return aAmt < bAmt ? -1 : aAmt > bAmt ? 1 : 0
    })

    if (endpoints.length === 0) {
      printCheck(warn('Paid endpoints found', 'No endpoints with x-payment-info'))
      counts.warnings++
      console.log(pc.dim('  Use --endpoint to specify endpoints manually.'))
      return { endpoints, discoveryDoc, shouldExit: true }
    }

    printCheck(check('Paid endpoints found', `${endpoints.length} endpoint(s)`))
    counts.passed++
  }

  return { endpoints, discoveryDoc }
}

async function validateEndpoints(
  baseUrl: string,
  endpoints: EndpointSpec[],
  discoveryDoc: Record<string, unknown> | null,
  counts: Counts,
  options: {
    verbose: boolean
    endpoint?: string | undefined
    body?: string | undefined
    query?: string[] | undefined
    yes: boolean
  },
): Promise<{ sawMppEndpoint: boolean; sawNonMppPaymentEndpoint: boolean; sawTestnet: boolean; sawMainnet: boolean; paymentSucceeded: boolean }> {
  let sawTestnet = false
  let sawMainnet = false
  let paymentSucceeded = false
  let sawMppEndpoint = false
  let sawNonMppPaymentEndpoint = false

  for (const endpoint of endpoints) {
    printSection(`${endpoint.method} ${endpoint.path}`)

    // With --endpoint, --body is used directly. In discovery mode, resolve per-path or auto-generate.
    let body: string | undefined
    if (options.endpoint) {
      body = options.body
    } else {
      body = resolveBodyForEndpoint(options.body, endpoint.path)
      if (!body && discoveryDoc) {
        body = extractRequestBodyFromDiscovery(discoveryDoc, endpoint)
        if (body && options.verbose) {
          console.log(pc.dim(`  Auto-generated body: ${body}`))
        }
      }
    }

    // Challenge
    console.log(pc.dim('  Challenge'))
    const { results: challengeResults, resolvedBody } = await validateChallenge(baseUrl, endpoint, options.verbose, {
      body,
      query: options.query,
      discoveryDoc: discoveryDoc ?? undefined,
    })
    const effectiveBody = resolvedBody ?? body
    printResults(challengeResults, counts)

    const isMppEndpoint = challengeResults.some(
      (r) => r.severity === 'pass' && r.label === 'Challenge parseable',
    )
    if (!isMppEndpoint) {
      if (challengeResults.some((r) => r.label === 'Not an MPP endpoint')) sawNonMppPaymentEndpoint = true
      continue
    }
    sawMppEndpoint = true

    const isTestnetEndpoint = challengeResults.some(
      (r) => r.severity === 'pass' && r.label === 'Valid currency address' && r.detail === 'testnet',
    )
    if (isTestnetEndpoint) sawTestnet = true
    else sawMainnet = true

    // Error Handling
    console.log(pc.dim('  Error Handling'))
    const errorResults = await validateErrorHandling(baseUrl, endpoint, {
      body: effectiveBody,
      query: options.query,
    })
    printResults(errorResults, counts)

    // Payment
    console.log(pc.dim('  Payment'))
    const paymentResults = await validatePaymentFlow(baseUrl, endpoint, options.verbose, {
      body: effectiveBody,
      query: options.query,
      yes: options.yes,
    })
    printResults(paymentResults, counts)
    if (paymentResults.some((r) => r.severity === 'pass' && r.label === 'Payment: successful')) {
      paymentSucceeded = true
    }
  }

  return { sawMppEndpoint, sawNonMppPaymentEndpoint, sawTestnet, sawMainnet, paymentSucceeded }
}

function printSummary(
  counts: Counts,
  flags: { sawMppEndpoint: boolean; sawNonMppPaymentEndpoint: boolean; sawTestnet: boolean; sawMainnet: boolean; paymentSucceeded: boolean },
  endpointsLength: number,
): void {
  // No MPP endpoints found
  if (!flags.sawMppEndpoint && endpointsLength > 0) {
    console.log('')
    if (flags.sawNonMppPaymentEndpoint) {
      console.log(pc.yellow(`  No MPP endpoints found. Tested ${endpointsLength} endpoint(s) but none use WWW-Authenticate: Payment.`))
      console.log(pc.dim('  This server may use x402 or another payment protocol.'))
    } else if (counts.skipped > 0 && counts.failed === 0) {
      console.log(pc.yellow(`  Could not reach payment gate on any endpoint (all returned 401/403/200).`))
      console.log(pc.dim('  The server may require authentication before payment. Try providing auth or use --endpoint with a public path.'))
    } else {
      console.log(pc.yellow(`  No MPP endpoints found. Tested ${endpointsLength} endpoint(s) but none use WWW-Authenticate: Payment.`))
      console.log(pc.dim('  This server may use x402 or another payment protocol.'))
    }
    console.log('')
    process.exit(1)
  }

  // Summary
  console.log('')
  const parts: string[] = []
  if (counts.passed > 0) parts.push(pc.green(`${counts.passed} passed`))
  if (counts.failed > 0) parts.push(pc.red(`${counts.failed} failed`))
  if (counts.warnings > 0) parts.push(pc.yellow(`${counts.warnings} warning(s)`))
  if (counts.skipped > 0) parts.push(pc.yellow(`${counts.skipped} skipped`))
  console.log(`${pc.bold('Summary:')} ${parts.join(', ')}`)

  // Cross-promotion
  if (flags.paymentSucceeded && flags.sawTestnet && !flags.sawMainnet) {
    console.log('')
    console.log(pc.dim('  Tip: validate your mainnet server too to confirm real payments work end-to-end.'))
  } else if (flags.sawMainnet && !flags.sawTestnet) {
    console.log('')
    console.log(pc.dim('  Tip: validate a testnet server too for free. This CLI automatically provisions and funds a testnet wallet for testing.'))
  }

  console.log('')

  if (counts.failed > 0) process.exit(1)
}
