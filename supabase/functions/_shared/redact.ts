// Log hygiene: Deno fetch errors embed the full request URL, which for Telegram contains the bot token.
// Pure TypeScript (also runs in Deno).

/** Replace every occurrence of each secret in `text` with `***`. Empty secrets are ignored. */
export function redact(text: unknown, secrets: string[]): string {
  let out = text instanceof Error ? text.message : String(text)
  for (const s of secrets) {
    if (s) out = out.split(s).join('***')
  }
  return out
}
