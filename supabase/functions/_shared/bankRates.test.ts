import { describe, expect, it } from 'vitest'
import { loadBankRates, MAIB_URL, parseMaib, parsePrivat, PRIVAT_URL } from './bankRates.ts'

const PRIVAT = [{ ccy: 'EUR', base_ccy: 'UAH', buy: '50.30000', sale: '51.30000' }, { ccy: 'USD', base_ccy: 'UAH', buy: '45.25000', sale: '45.95000' }]
const row = (c: string, a: string, b: string, n: string) =>
  `<tr> <td>${c}</td> <td> <span class="arrow__icon "> ${a} </span> </td> <td> <span class="arrow__icon "> ${b} </span> </td> <td> <span class="arrow__icon "> ${n} </span> </td> </tr>`
const MAIB = `<p>rate</p><table class="table exchange__table"><thead><tr><th></th><th>buy</th></tr></thead><tbody>${row('EUR', '20.0300', '20.2800', '20.0954')}${row('USD', '17.8500', '18.1500', '18.0365')}</tbody></table>
<table class="table exchange__table">${row('USD', '1.0000', '2.0000', '3.0000')}</table>`

describe('bank rates', () => {
  it('PrivatBank: buy and sale by currency; garbage gives nothing', () => {
    expect(parsePrivat(PRIVAT, 'USD')).toEqual({ buy: 45.25, sell: 45.95 })
    expect(parsePrivat(PRIVAT, 'EUR')).toEqual({ buy: 50.3, sell: 51.3 })
    expect(parsePrivat({ error: 1 }, 'USD')).toBeNull()
    expect(parsePrivat([{ ccy: 'USD', buy: 'x', sale: '1' }], 'USD')).toBeNull()
  })
  it('maib: buy and sell from the first table, not the official column', () => {
    expect(parseMaib(MAIB, 'USD')).toEqual({ buy: 17.85, sell: 18.15 })
    expect(parseMaib(MAIB, 'EUR')).toEqual({ buy: 20.03, sell: 20.28 })
    expect(parseMaib('<html>new design</html>', 'USD')).toBeNull()
  })
  it('sell below buy is a broken page, not a rate', () => {
    expect(parseMaib(`<table class="table exchange__table">${row('USD', '18.0000', '17.0000', '1')}</table>`, 'USD')).toBeNull()
  })
  it('one source down: the other still answers', async () => {
    const fetcher = async (url: string) => {
      if (url === PRIVAT_URL) throw new Error('down')
      expect(url).toBe(MAIB_URL)
      return new Response(MAIB)
    }
    const r = await loadBankRates(fetcher)
    expect(r.USD).toEqual({ uah: null, mdl: { buy: 17.85, sell: 18.15 } })
  })
})
