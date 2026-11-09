// Records which steps of the server code ran for one request, so the page can light up
// the diagram and the matching source lines. Each step ID has a `// step: <id>` marker
// above the code it names; the page finds that line in the source it displays.

/** One step the server ran. */
export type Step = { id: string; detail?: string | undefined }

/** Response header carrying the steps, as base64url JSON. */
export const header = 'Fortune-Trace'

/** Collects the steps of one request. */
export function create() {
  const steps: Step[] = []
  return {
    step(id: string, detail?: string) {
      steps.push(detail === undefined ? { id } : { id, detail })
    },
    /** Returns a copy of `response` carrying the steps. */
    attach(response: Response): Response {
      const result = new Response(response.body, response)
      result.headers.set(header, encode(steps))
      return result
    },
  }
}

export type Trace = ReturnType<typeof create>

function encode(steps: Step[]): string {
  const bytes = new TextEncoder().encode(JSON.stringify(steps))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

/** Decodes the steps of a response, or none. */
export function decode(value: string | null): Step[] {
  if (!value) return []
  try {
    const binary = atob(value.replaceAll('-', '+').replaceAll('_', '/'))
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0))))
  } catch {
    return []
  }
}
