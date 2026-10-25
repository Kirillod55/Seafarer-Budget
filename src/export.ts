// The CSV text itself lives in shared code (the bot reuses it); only the browser download stays here.
export { toCsv } from '@shared/csv.ts'

// Generous: Safari / WKWebView may read the blob well after the click handler returns.
const REVOKE_DELAY_MS = 10_000

export const csvFileName = (date: string) => `seafarer-budget-${date}.csv`

/** Saves text as a file through a temporary `<a download>` (works in Tauri's webview and Safari). */
export function downloadCsv(fileName: string, csv: string): void {
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  link.hidden = true
  document.body.appendChild(link)
  try {
    link.click()
  } finally {
    link.remove()
    // not at once: Safari starts reading the blob after the click handler returns
    setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS)
  }
}
