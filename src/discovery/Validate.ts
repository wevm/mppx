import { DiscoveryDocument, PaymentInfo } from './Discovery.js'

export type ValidationError = {
  path: string
  message: string
  severity: 'error' | 'warning'
}

/**
 * Validates a discovery document.
 *
 * 1. Parses the top-level structure via Zod.
 * 2. Checks semantic rules:
 *    - Every operation with `x-payment-info` MUST have a `402` response.
 *    - Warns if an operation with `x-payment-info` has no `requestBody`.
 * 3. Returns structured errors with paths.
 */
export function validate(doc: unknown): ValidationError[] {
  const errors: ValidationError[] = []

  const result = DiscoveryDocument.safeParse(doc)
  if (!result.success) {
    for (const issue of result.error.issues) {
      errors.push({
        path: issue.path.map(String).join('.') || '(root)',
        message: issue.message,
        severity: 'error',
      })
    }
    return errors
  }

  const parsed = result.data
  const paths = parsed.paths
  if (!paths) return errors

  for (const [pathKey, methods] of Object.entries(paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      const opPath = `paths.${pathKey}.${method}`

      const rawPaymentInfo = (operation as Record<string, unknown>)['x-payment-info']
      if (!rawPaymentInfo) continue

      const paymentResult = PaymentInfo.safeParse(rawPaymentInfo)
      if (!paymentResult.success) {
        for (const issue of paymentResult.error.issues) {
          errors.push({
            path: `${opPath}.x-payment-info.${issue.path.map(String).join('.')}`,
            message: issue.message,
            severity: 'error',
          })
        }
        continue
      }

      const responses = operation.responses as Record<string, unknown> | undefined
      if (!responses || !('402' in responses)) {
        errors.push({
          path: `${opPath}.responses`,
          message: 'Operation with x-payment-info MUST have a 402 response',
          severity: 'error',
        })
      }

      if (!operation.requestBody) {
        errors.push({
          path: opPath,
          message: 'Operation with x-payment-info has no requestBody',
          severity: 'warning',
        })
      }
    }
  }

  return errors
}
