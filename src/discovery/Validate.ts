import { DiscoveryDocument, PaymentInfo } from './Discovery.js'

export type ValidationError = {
  message: string
  path: string
  severity: 'error' | 'warning'
}

/**
 * Validates a discovery document structurally and semantically.
 */
export function validate(doc: unknown): ValidationError[] {
  const errors: ValidationError[] = []

  const result = DiscoveryDocument.safeParse(doc)
  if (!result.success) {
    for (const issue of result.error.issues) {
      errors.push({
        message: issue.message,
        path: issue.path.map(String).join('.') || '(root)',
        severity: 'error',
      })
    }
    return errors
  }

  const parsed = result.data
  const paths = parsed.paths
  if (!paths) return errors

  for (const [pathKey, pathItem] of Object.entries(paths)) {
    for (const [method, operation] of Object.entries(pathItem as Record<string, unknown>)) {
      if (!operation || typeof operation !== 'object' || Array.isArray(operation)) continue
      const op = operation as Record<string, unknown>

      const opPath = `paths.${pathKey}.${method}`
      const rawPaymentInfo = op['x-payment-info']
      if (!rawPaymentInfo) continue

      const paymentResult = PaymentInfo.safeParse(rawPaymentInfo)
      if (!paymentResult.success) {
        for (const issue of paymentResult.error.issues) {
          const issuePath = issue.path.length > 0 ? `.${issue.path.map(String).join('.')}` : ''
          errors.push({
            message: issue.message,
            path: `${opPath}.x-payment-info${issuePath}`,
            severity: 'error',
          })
        }
        continue
      }

      const responses = op.responses as Record<string, unknown> | undefined
      if (!responses || !('402' in responses)) {
        errors.push({
          message: 'Operation with x-payment-info MUST have a 402 response',
          path: `${opPath}.responses`,
          severity: 'error',
        })
      }

      const methodUpper = method.toUpperCase()
      if (
        !op.requestBody &&
        (methodUpper === 'POST' || methodUpper === 'PUT' || methodUpper === 'PATCH')
      ) {
        errors.push({
          message: 'Operation with x-payment-info has no requestBody',
          path: opPath,
          severity: 'warning',
        })
      }
    }
  }

  return errors
}
