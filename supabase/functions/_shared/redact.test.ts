import { describe, expect, it } from 'vitest'
import { redact } from './redact.ts'

describe('redact', () => {
  const TOKEN = '123456:ABC-secret'

  it('removes the token from a fetch error message', () => {
    const err = new TypeError(`error sending request for url (https://api.telegram.org/bot${TOKEN}/sendMessage)`)
    const out = redact(err, [TOKEN])
    expect(out).not.toContain(TOKEN)
    expect(out).toContain('https://api.telegram.org/bot***/sendMessage')
  })

  it('removes every occurrence and handles non-Error values', () => {
    expect(redact(`${TOKEN} and ${TOKEN}`, [TOKEN])).toBe('*** and ***')
    expect(redact(42, [TOKEN])).toBe('42')
  })

  it('ignores empty secrets instead of mangling the text', () => {
    expect(redact('hello', ['', TOKEN])).toBe('hello')
  })
})
