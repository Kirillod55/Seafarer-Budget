import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { alive } from '@shared/alive.ts'
import { localDate } from '@shared/dates.ts'
import { DEFAULT_CATEGORIES } from '@shared/defaults.ts'
import { money } from '@shared/format.ts'
import type { Settings, SoftDeletable, Transaction } from '@shared/types.ts'
import { RESTORE_MS, restorable, selectForWipe, wipeFrom, type WipeKind, type WipeScope } from '@shared/wipe.ts'
import { useApp } from '../../context.tsx'
import { csvFileName, downloadCsv, toCsv } from '../../export.ts'
import { Morph } from '../../ui/Morph.tsx'
import { prefersReducedMotion } from '../../ui/motion.ts'
import { Segmented } from '../../ui/Segmented.tsx'
import { useToast } from '../../ui/Toast.tsx'
import { dayMonth, plural } from '../../ui/dates.ts'
import { Check } from '../../ui/icons.ts'
import { Wizard } from '../Wizard.tsx'
import { FAILED, MoreCard } from './common.tsx'

type Mode = 'rec' | 'all'

/** meta key of the last «Удаление данных» (local only: the undo lives on this device, like the toast) */
const LAST_WIPE = 'lastWipe'
interface LastWipe {
  batch: string
  /** «54 записи» / «все данные» */
  what: string
  mode: Mode
}

/** how long «Удалить N записей» stays armed as «Нажми ещё раз — удалить» */
const ARM_MS = 4000

const SCOPES: { value: WipeScope; label: string }[] = [
  { value: 'day', label: 'Сутки' },
  { value: 'week', label: 'Неделя' },
  { value: 'month', label: 'Месяц' },
  { value: 'all', label: 'Всё время' },
]
const KINDS: { value: WipeKind; label: string }[] = [
  { value: 'expense', label: 'Траты' },
  { value: 'income', label: 'Доходы' },
  { value: 'all', label: 'Всё' },
]
const STANDARD = new Set(DEFAULT_CATEGORIES.map((c) => c.name))

const records = (n: number) => plural(n, 'запись', 'записи', 'записей')

/** «сегодня, 21 октября» / «22 сентября — 21 октября» / «все записи с самого начала» */
function rangeText(scope: WipeScope, today: string): string {
  const from = wipeFrom(scope, today)
  if (from === null) return 'все записи с самого начала'
  return from === today ? `сегодня, ${dayMonth(today)}` : `${dayMonth(from)} — ${dayMonth(today)}`
}

/** «26 октября, 06:23» in the book's time zone */
function until(ms: number, timeZone: string): string {
  const d = new Date(ms)
  const time = new Intl.DateTimeFormat('ru-RU', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d)
  return `${dayMonth(localDate(d, timeZone))}, ${time}`
}

/**
 * The box's height glides (0.34 s) when `dep` changes its number of lines (the sum and «За этот период таких записей
 * нет» wrap differently): the card grows or shrinks smoothly instead of snapping. A change mid-glide starts from what
 * is on screen.
 */
function useHeightGlide(ref: RefObject<HTMLElement | null>, dep: string) {
  const last = useRef<number | null>(null)
  const anim = useRef<Animation | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) {
      last.current = null
      return
    }
    let h0 = last.current
    if (anim.current) {
      h0 = el.offsetHeight // the animated height on screen
      anim.current.cancel()
      anim.current = null
    }
    const h1 = el.offsetHeight
    last.current = h1
    if (h0 === null || h0 === h1 || prefersReducedMotion() || typeof el.animate !== 'function') return
    const a = el.animate([{ height: `${h0}px` }, { height: `${h1}px` }], { duration: 340, easing: 'cubic-bezier(.2,.8,.2,1)' })
    a.onfinish = () => {
      if (anim.current === a) anim.current = null
    }
    anim.current = a
  }, [dep, ref])
}

const byDate =(a: Transaction, b: Transaction) => a.date.localeCompare(b.date) || a.created_at.localeCompare(b.created_at)

/*
 * «Удаление данных» (spec §4 «Удаление данных», §6 «Плавная перерисовка»; prototype v60 wipePanel(), wipeShow(),
 * doWipe(), undoWipe()). Everything happens inside this card: the intro, the «Удалить записи…» / «Удалить все
 * данные…» panels and the «Вернуть удалённое» row swap in one Morph block (old content fades, new fades in, the
 * height glides); the period and kind switch with the pill and the sum, dates and button text change in place — the
 * header and the other cards never move. The first press arms the red button for 4 s, the second deletes (into the
 * 24 h bin, as one batch). After «Удалить все данные» the wizard asks the opening balance (only that step).
 * Owner only — the app is always the owner (the partner writes through the bot).
 */
export function WipeSection({ settings, today }: { settings: Settings; today: string }) {
  const { db, repo, now } = useApp()
  const toast = useToast()
  const [mode, setMode] = useState<Mode | null>(null)
  const [scope, setScope] = useState<WipeScope>('month')
  const [kind, setKind] = useState<WipeKind>('expense')
  const [csv, setCsv] = useState(true)
  const [armed, setArmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [wizard, setWizard] = useState(false)
  const armTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [, setTick] = useState(0)
  const sumRef = useRef<HTMLDivElement>(null)

  const data = useLiveQuery(async () => {
    const [txs, goals, limits, categories, last] = await Promise.all([
      db.transactions.filter(alive).toArray(),
      db.goals.filter(alive).count(),
      db.limits.filter(alive).count(),
      db.categories.filter((c) => alive(c) && !STANDARD.has(c.name)).count(),
      db.meta.get(LAST_WIPE),
    ])
    const lastWipe = last?.value as LastWipe | undefined
    let binned: SoftDeletable[] = []
    if (lastWipe) {
      const inBatch = (r: SoftDeletable) => r.deleted_batch === lastWipe.batch
      const parts = await Promise.all([
        db.transactions.filter(inBatch).toArray(),
        db.goals.filter(inBatch).toArray(),
        db.limits.filter(inBatch).toArray(),
        db.categories.filter(inBatch).toArray(),
      ])
      binned = parts.flat()
    }
    return { txs, goals, limits, ownCategories: categories, lastWipe, binned }
  }, [db])

  const disarm = () => {
    clearTimeout(armTimer.current)
    setArmed(false)
  }
  useEffect(() => () => clearTimeout(armTimer.current), [])

  // the «Вернуть удалённое» row: while the batch is in the bin and its 24 h have not run out
  const nowMs = now().getTime()
  const last = data?.lastWipe
  const restoreAt =
    last && restorable(data.binned, last.batch, nowMs)
      ? Math.min(...data.binned.filter((r) => r.deleted_at).map((r) => Date.parse(r.deleted_at!))) + RESTORE_MS
      : null
  // hide the row when its time runs out, even if nothing else changes
  useEffect(() => {
    if (restoreAt === null) return
    const t = setTimeout(() => setTick((n) => n + 1), Math.min(restoreAt - nowMs + 1000, 2 ** 31 - 1))
    return () => clearTimeout(t)
  }, [restoreAt, nowMs])
  useHeightGlide(sumRef, `${mode}|${scope}|${kind}|${data?.txs.length ?? 0}`)

  if (!data) return <MoreCard title="Удаление данных" className="wipecard">{null}</MoreCard>

  const chosen = selectForWipe(data.txs, scope, kind, today)
  const sumUsd = (k: Transaction['kind']) => chosen.filter((t) => t.kind === k).reduce((s, t) => s + t.amount_usd, 0)
  const spent = sumUsd('expense')
  const earned = sumUsd('income')
  const allCount = data.txs.length + data.goals + data.limits + data.ownCategories
  const count = mode === 'all' ? allCount : chosen.length
  const goLabel = !count ? 'Удалять нечего' : mode === 'all' ? 'Удалить все данные' : `Удалить ${records(chosen.length)}`
  const partner = settings.partner_name?.trim() || 'второй человек'

  const open = (m: Mode) => {
    disarm()
    if (mode === m) return setMode(null)
    setScope('month')
    setKind('expense')
    setCsv(true)
    setMode(m)
  }

  const undo = async (lw: LastWipe) => {
    await repo.restore(lw.batch)
    const cur = (await db.meta.get(LAST_WIPE))?.value as LastWipe | undefined
    if (cur?.batch === lw.batch) await db.meta.delete(LAST_WIPE)
    if (lw.mode === 'all') setWizard(false)
    toast(lw.mode === 'all' ? 'Данные вернулись' : 'Записи вернулись')
  }

  async function go() {
    if (!mode || busy || !count) return
    if (!armed) {
      setArmed(true)
      clearTimeout(armTimer.current)
      armTimer.current = setTimeout(() => setArmed(false), ARM_MS)
      return
    }
    disarm()
    setBusy(true)
    try {
      if (csv) {
        // the copy first: if it cannot be saved, nothing is deleted
        const [txs, categories, accounts] = await Promise.all([
          db.transactions.toArray(),
          db.categories.toArray(),
          db.accounts.toArray(),
        ])
        const rows = (mode === 'all' ? txs.filter(alive) : selectForWipe(txs, scope, kind, today)).sort(byDate)
        downloadCsv(mode === 'all' ? csvFileName(today) : `seafarer-budget-udalennye-${today}.csv`, toCsv(rows, categories, accounts, settings.partner_name))
      }
      const { batch, count: n } = mode === 'all' ? await repo.wipeAll() : await repo.wipe(scope, kind)
      const lw: LastWipe = { batch, mode, what: mode === 'all' ? 'все данные' : records(n) }
      await db.meta.put({ key: LAST_WIPE, value: lw })
      setMode(null)
      toast(mode === 'all' ? 'Все данные удалены' : `Удалено ${lw.what}`, { label: 'Вернуть', run: () => undo(lw) })
      if (mode === 'all') setWizard(true)
    } catch {
      toast(FAILED)
    } finally {
      setBusy(false)
    }
  }

  const restoreRow = last && restoreAt !== null && (
    <div className="wundo">
      <span className="label">{`Удалено: ${last.what}. Вернуть можно до ${until(restoreAt, settings.timezone)}`}</span>
      <button type="button" className="btn-gray" onClick={() => undo(last).catch(() => toast(FAILED))}>
        Вернуть удалённое
      </button>
    </div>
  )

  return (
    <MoreCard title="Удаление данных" className="wipecard">
      <Morph k={`${mode ?? 'intro'}:${restoreAt !== null ? last!.batch : ''}`} className="wbox">
        {mode === null ? (
          <>
            <p className="label">Удалить записи за сутки, неделю, месяц или всю историю. 24 часа удалённое можно вернуть.</p>
            <button type="button" className="btn-gray danger" onClick={() => open('rec')}>
              Удалить записи…
            </button>
            <button type="button" className="btn-gray danger" onClick={() => open('all')}>
              Удалить все данные…
            </button>
          </>
        ) : (
          <div className="wipe" role="group" aria-label={mode === 'all' ? 'Удалить все данные' : 'Удалить записи'}>
            {mode === 'all' ? (
              <p className="wlead">
                Удалятся <b>все записи</b>
                {` (${data.txs.length}), цели (${data.goals}), лимиты (${data.limits}) и свои категории (${data.ownCategories}). Останутся настройки: дата посадки, запас, валюты, тема, бот и ${partner}. Потом мастер спросит остаток заново.`}
              </p>
            ) : (
              <>
                <div className="fld">
                  <span className="flabel">Период</span>
                  <Segmented<WipeScope>
                    label="Период"
                    options={SCOPES}
                    value={scope}
                    onChange={(v) => {
                      disarm()
                      setScope(v)
                    }}
                  />
                  <span className="label wrange">{rangeText(scope, today)}</span>
                </div>
                <div className="fld">
                  <span className="flabel">Что</span>
                  <Segmented<WipeKind>
                    label="Что удалить"
                    options={KINDS}
                    value={kind}
                    onChange={(v) => {
                      disarm()
                      setKind(v)
                    }}
                  />
                </div>
                <div ref={sumRef} className={`wsum num${chosen.length ? '' : ' empty'}`} aria-live="polite">
                  {chosen.length ? (
                    <>
                      Удалю <b>{records(chosen.length)}</b>
                      {spent ? ` · траты ${money(spent, 'USD')}` : ''}
                      {earned ? ` · доходы ${money(earned, 'USD')}` : ''}
                    </>
                  ) : (
                    'За этот период таких записей нет'
                  )}
                </div>
              </>
            )}
            <label className="wcheck">
              <input type="checkbox" checked={csv} onChange={(e) => setCsv(e.target.checked)} />
              <span className="wtick" aria-hidden="true">
                <Check strokeWidth={2.6} />
              </span>
              Сначала скачать копию (CSV)
            </label>
            <p className="label">
              Баланс изменится: удалённые траты больше не вычитаются, доходы не прибавляются. 24 часа удалённое можно вернуть.
            </p>
            <div className="wact">
              <button
                type="button"
                className="btn-gray"
                onClick={() => {
                  disarm()
                  setMode(null)
                }}
              >
                Отмена
              </button>
              <button type="button" className={`wdanger${armed ? ' armed' : ''}`} disabled={!count || busy} onClick={() => void go()}>
                {armed ? 'Нажми ещё раз — удалить' : goLabel}
              </button>
            </div>
          </div>
        )}
        {restoreRow}
      </Morph>
      {wizard &&
        createPortal(
          <div className="wzlayer">
            <Wizard startAt="balance" onDone={() => setWizard(false)} />
          </div>,
          document.body,
        )}
    </MoreCard>
  )
}
