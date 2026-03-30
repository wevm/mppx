import * as path from 'node:path'

export function renderDevScripts(pageDir: string): string {
  const pageScriptSrc = '/@fs/' + path.resolve(pageDir, 'src/page.ts').replaceAll('\\', '/')
  const debugToolbarScriptSrc =
    '/@fs/' + path.resolve(pageDir, '../internal/debugToolbar.ts').replaceAll('\\', '/')
  return `<script type="module" src="${pageScriptSrc}"></script>\n  <script type="module" src="${debugToolbarScriptSrc}"></script>`
}
