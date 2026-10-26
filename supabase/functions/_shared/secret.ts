// Constant-time comparison of a secret header with the expected secret (Telegram webhook, keepalive).
// Runs in Deno and in vitest; no npm imports.

/**
 * true only when `given` equals a non-empty `expected`. Time depends on the expected length only, not on
 * where the strings differ (the lengths are compared inside the same loop, not by an early return).
 */
export function safeEqual(given: string | null | undefined, expected: string): boolean {
  if (!expected) return false
  const enc = new TextEncoder()
  const a = enc.encode(given ?? '')
  const b = enc.encode(expected)
  let diff = a.length ^ b.length
  for (let i = 0; i < b.length; i++) diff |= (a[i] ?? 0) ^ b[i]
  return diff === 0
}
