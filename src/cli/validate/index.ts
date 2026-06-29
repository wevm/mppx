import { Cli, z } from 'incur'

import { validate as validateDiscovery } from '../../discovery/Validate.js'
import { pc } from '../utils.js'
import { validateChallenge, validateErrorHandling } from './challenge.js'
import { extractEndpointsFromDiscovery, extractRequestBodyFromDiscovery, fetchDiscoveryDoc } from './discovery.js'
import { check, fail, parseEndpointArg, printCheck, printSection, resolveBodyForEndpoint, warn } from './helpers.js'
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
    let totalPassed = 0
    let totalFailed = 0
    let totalWarnings = 0
    let totalSkipped = 0

    console.log(`\n${pc.bold('mppx validate')} ${pc.dim(baseUrl)}\n`)

    // Phase 1: Discovery (always runs)
    let endpoints: import('./helpers.js').EndpointSpec[] = []
    let discoveryDoc: Record<string, unknown> | null = null

    printSection('Discovery (/openapi.json)')
    const discoveryResult = await fetchDiscoveryDoc(baseUrl)

    if ('error' in discoveryResult) {
      printCheck(fail('Document found', discoveryResult.error, 'MPP servers must serve an OpenAPI document at /openapi.json with x-payment-info extensions.'))
      totalFailed++
      if (!c.options.endpoint) {
        console.log('')
        console.log(pc.yellow('  No discovery document found.'))
        console.log(pc.dim('  MPP servers must serve an OpenAPI document at /openapi.json with x-payment-info extensions.'))
        console.log(pc.dim('  To test a specific endpoint: mppx validate <url> --endpoint POST:/your/path'))
        console.log('')
        process.exit(1)
      }
    } else {
      printCheck(check('Document found and parseable'))
      totalPassed++

      const issues = validateDiscovery(discoveryResult.doc)
      const errors = issues.filter((i) => i.severity === 'error')
      const warnings = issues.filter((i) => i.severity === 'warning')

      if (errors.length > 0) {
        printCheck(fail('Valid OpenAPI structure', `${errors.length} error(s)`))
        totalFailed++
        for (const issue of errors) {
          console.log(pc.dim(`    ${issue.path}: ${issue.message}`))
        }
      } else {
        printCheck(check('Valid OpenAPI structure'))
        totalPassed++
      }

      for (const w of warnings) {
        printCheck(warn(w.message, w.path))
        totalWarnings++
      }

      discoveryDoc = discoveryResult.doc as Record<string, unknown>
    }

    // Resolve endpoints: --endpoint overrides discovery
    if (c.options.endpoint) {
      const parsed = parseEndpointArg(c.options.endpoint)
      if (!parsed) {
        console.log(pc.red(`Invalid endpoint format: "${c.options.endpoint}". Use METHOD:path (e.g. GET:/api/data)`))
        process.exit(1)
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
        totalWarnings++
        console.log(pc.dim('  Use --endpoint to specify endpoints manually.'))
        process.exit(1)
      }

      printCheck(check('Paid endpoints found', `${endpoints.length} endpoint(s)`))
      totalPassed++
    }

    // Phase 2: Validate each endpoint
    let sawTestnet = false
    let sawMainnet = false
    let paymentSucceeded = false
    let sawMppEndpoint = false
    let sawNonMppPaymentEndpoint = false

    for (const endpoint of endpoints) {
      printSection(`${endpoint.method} ${endpoint.path}`)

      // With --endpoint, --body is used directly. In discovery mode, resolve per-path or auto-generate.
      let body: string | undefined
      if (c.options.endpoint) {
        body = c.options.body
      } else {
        body = resolveBodyForEndpoint(c.options.body, endpoint.path)
        if (!body && discoveryDoc) {
          body = extractRequestBodyFromDiscovery(discoveryDoc, endpoint)
          if (body && verbose) {
            console.log(pc.dim(`  Auto-generated body: ${body}`))
          }
        }
      }

      // Challenge
      console.log(pc.dim('  Challenge'))
      const { results: challengeResults, resolvedBody } = await validateChallenge(baseUrl, endpoint, verbose, {
        body,
        query: c.options.query,
        discoveryDoc: discoveryDoc ?? undefined,
      })
      const effectiveBody = resolvedBody ?? body
      for (const result of challengeResults) {
        printCheck(result)
        if (result.severity === 'pass') totalPassed++
        else if (result.severity === 'fail') totalFailed++
        else if (result.severity === 'warn') totalWarnings++
        else if (result.severity === 'skip') totalSkipped++
      }

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
        query: c.options.query,
      })
      for (const result of errorResults) {
        printCheck(result)
        if (result.severity === 'pass') totalPassed++
        else if (result.severity === 'fail') totalFailed++
        else if (result.severity === 'warn') totalWarnings++
        else if (result.severity === 'skip') totalSkipped++
      }

      // Payment
      console.log(pc.dim('  Payment'))
      const paymentResults = await validatePaymentFlow(baseUrl, endpoint, verbose, {
        body: effectiveBody,
        query: c.options.query,
        yes: c.options.yes,
      })
      for (const result of paymentResults) {
        printCheck(result)
        if (result.severity === 'pass') totalPassed++
        else if (result.severity === 'fail') totalFailed++
        else if (result.severity === 'warn') totalWarnings++
        else if (result.severity === 'skip') totalSkipped++
      }
      if (paymentResults.some((r) => r.severity === 'pass' && r.label === 'Payment: successful')) {
        paymentSucceeded = true
      }
    }

    // No MPP endpoints found
    if (!sawMppEndpoint && endpoints.length > 0) {
      console.log('')
      if (sawNonMppPaymentEndpoint) {
        console.log(pc.yellow(`  No MPP endpoints found. Tested ${endpoints.length} endpoint(s) but none use WWW-Authenticate: Payment.`))
        console.log(pc.dim('  This server may use x402 or another payment protocol.'))
      } else if (totalSkipped > 0 && totalFailed === 0) {
        console.log(pc.yellow(`  Could not reach payment gate on any endpoint (all returned 401/403/200).`))
        console.log(pc.dim('  The server may require authentication before payment. Try providing auth or use --endpoint with a public path.'))
      } else {
        console.log(pc.yellow(`  No MPP endpoints found. Tested ${endpoints.length} endpoint(s) but none use WWW-Authenticate: Payment.`))
        console.log(pc.dim('  This server may use x402 or another payment protocol.'))
      }
      console.log('')
      process.exit(1)
    }

    // Summary
    console.log('')
    const parts: string[] = []
    if (totalPassed > 0) parts.push(pc.green(`${totalPassed} passed`))
    if (totalFailed > 0) parts.push(pc.red(`${totalFailed} failed`))
    if (totalWarnings > 0) parts.push(pc.yellow(`${totalWarnings} warning(s)`))
    if (totalSkipped > 0) parts.push(pc.yellow(`${totalSkipped} skipped`))
    console.log(`${pc.bold('Summary:')} ${parts.join(', ')}`)

    // Cross-promotion
    if (paymentSucceeded && sawTestnet && !sawMainnet) {
      console.log('')
      console.log(pc.dim('  Tip: validate your mainnet server too to confirm real payments work end-to-end.'))
    } else if (sawMainnet && !sawTestnet) {
      console.log('')
      console.log(pc.dim('  Tip: validate a testnet server too for free. This CLI automatically provisions and funds a testnet wallet for testing.'))
    }

    console.log('')

    if (totalFailed > 0) process.exit(1)
  },
})

export default validate
