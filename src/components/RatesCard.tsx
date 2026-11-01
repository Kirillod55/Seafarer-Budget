import type { RatesView } from '@shared/ratesText.ts'
import { dayMonth } from '../ui/dates.ts'
import './rates-card.css'

const SIGN = { USD: '$', EUR: '€' }
const num = (n: number | null) => (n === null ? '—' : n.toFixed(2))

/**
 * «Курс валют» on the home screen (the PC overview column and the phone): what the bot sends, as a small table — each
 * currency in hryvnias and lei, buy and sell from the banks, or one official rate; the source is named at the bottom.
 */
export function RatesCard({ view }: { view: RatesView }) {
  return (
    <section className="card ratecard" aria-label="Курс валют">
      <header className="rc-head">
        <h3>Курс валют</h3>
        <span className="rc-date">{dayMonth(view.date)}</span>
      </header>
      <div className={`rc-table num${view.live ? '' : ' one'}`}>
        <div className="rc-cols" aria-hidden="true">
          {view.live ? (
            <>
              <span>Покупка</span>
              <span>Продажа</span>
            </>
          ) : (
            <span>Курс</span>
          )}
        </div>
        {view.blocks.map((b) => (
          <div key={b.unit} className="rc-block">
            <div className="rc-cur">
              <span className="rc-sign" aria-hidden="true">
                {SIGN[b.unit]}
              </span>
              {b.title}
            </div>
            {b.cells.map((c) => (
              <div key={c.label} className="rc-row">
                <span className="rc-label">{c.label}</span>
                {view.live ? (
                  <>
                    <span>{num(c.buy ?? c.one)}</span>
                    <span className="rc-strong">{num(c.sell ?? c.one)}</span>
                  </>
                ) : (
                  <span className="rc-strong">{num(c.one)}</span>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>
      <p className="rc-source">{view.source}</p>
    </section>
  )
}
