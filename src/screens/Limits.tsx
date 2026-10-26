import { useId, useRef, useState, type RefObject } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { alive } from '@shared/alive.ts'
import { limitStatus } from '@shared/calc.ts'
import { localDate, monthOf } from '@shared/dates.ts'
import { money } from '@shared/format.ts'
import { round2 } from '@shared/fx.ts'
import type { Category, Limit } from '@shared/types.ts'
import { useApp } from '../context.tsx'
import { parseAmount } from '../lib/amount.ts'
import { NavBar } from '../nav/NavBar.tsx'
import { CategoryIcon } from '../ui/CategoryIcon.tsx'
import { MONTHS_NOM } from '../ui/dates.ts'
import { onEnter } from '../ui/keys.ts'
import { Picker } from '../ui/Picker.tsx'
import { ProgressBar } from '../ui/ProgressBar.tsx'
import { useToast } from '../ui/Toast.tsx'
import '../ui/ui.css' // .pill ok / warn / over
import { useFlip } from '../ui/useFlip.ts'
import { useDayTick } from '../ui/useDayTick.ts'
import './record.css'
import './goals.css'
import './limits.css'

const FAILED = 'Не получилось — попробуй ещё раз'
const usd = (n: number) => money(n, 'USD', { whole: true })
const LEVEL: Record<'ok' | 'warn' | 'over', string> = { ok: 'В норме', warn: 'Почти всё', over: 'Превышен' }

/**
 * Saves a limit for a category. A row of that category in the undo bin (`deleted_at`) is brought back instead of
 * adding a second one; a row deleted for good (`deleted`, 1.0 or the purge) is never reused — the server keeps it
 * deleted, so a new id is made. New rows set the 1.1 fields.
 */
function useSaveLimit() {
  const { db, repo } = useApp()
  return async (categoryId: string, monthly: number, id?: string) => {
    const reuse = id ?? (await db.limits.filter((l) => l.category_id === categoryId && !l.deleted).first())?.id
    await repo.put<Limit>('limits', {
      id: reuse,
      category_id: categoryId,
      monthly_usd: round2(monthly),
      deleted: false,
      deleted_at: null,
      deleted_batch: null,
    })
  }
}

/** «Новый лимит» (prototype limits(), S.limNew): the category (a glass menu with icons) and «В месяц, $», one under another. */
function NewLimitCard({ choices, amountRef, onClose }: { choices: Category[]; amountRef: RefObject<HTMLInputElement | null>; onClose(): void }) {
  const toast = useToast()
  const save = useSaveLimit()
  const titleId = useId()
  const [categoryId, setCategoryId] = useState(choices[0]?.id ?? '')
  const [amount, setAmount] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  // a category that got a limit elsewhere meanwhile leaves the menu
  const chosen = choices.some((c) => c.id === categoryId) ? categoryId : (choices[0]?.id ?? '')

  async function submit() {
    if (busy) return
    const value = parseAmount(amount)
    if (!(value > 0)) return setError('Введите сумму')
    if (!chosen) return setError('Выберите категорию')
    setBusy(true)
    try {
      await save(chosen, value)
      onClose()
    } catch {
      toast(FAILED)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card gcard rec reveal limform" data-flip-key="new-limit" aria-labelledby={titleId}>
      <h3 id={titleId}>Новый лимит</h3>
      <div className="fld">
        <label htmlFor="l-cat">Категория</label>
        <Picker
          id="l-cat"
          label="Категория"
          kind="category"
          value={chosen}
          options={choices.map((c) => ({ value: c.id, label: c.name, icon: <CategoryIcon category={c} size="sm" /> }))}
          onChange={setCategoryId}
        />
      </div>
      <div className="fld">
        <label htmlFor="l-amt">В месяц, $</label>
        <input
          ref={amountRef}
          id="l-amt"
          className="inp num"
          type="text"
          inputMode="decimal"
          autoComplete="off"
          placeholder="100"
          aria-invalid={!!error}
          value={amount}
          onChange={(e) => {
            setAmount(e.target.value)
            if (error) setError('')
          }}
          onKeyDown={onEnter(() => void submit())}
        />
      </div>
      {error && (
        <p className="gerr" role="alert">
          {error}
        </p>
      )}
      <div className="gacts">
        <button type="button" className="btn-acc" disabled={busy} onClick={() => void submit()}>
          Сохранить
        </button>
        <button type="button" className="btn-gray" disabled={busy} onClick={onClose}>
          Отмена
        </button>
      </div>
    </section>
  )
}

/** The amount of a limit, edited inside its card (the 1.0 «изменить лимит» stays). */
function EditAmount({ limit, onClose }: { limit: Limit; onClose(): void }) {
  const toast = useToast()
  const save = useSaveLimit()
  const [amount, setAmount] = useState(String(limit.monthly_usd))
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit() {
    if (busy) return
    const value = parseAmount(amount)
    if (!(value > 0)) return setError('Введите сумму')
    setBusy(true)
    try {
      await save(limit.category_id, value, limit.id)
      onClose()
    } catch {
      toast(FAILED)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rec reveal limedit">
      <div className="fld">
        <label htmlFor={`l-edit-${limit.id}`}>В месяц, $</label>
        <input
          id={`l-edit-${limit.id}`}
          className="inp num"
          type="text"
          inputMode="decimal"
          autoComplete="off"
          aria-invalid={!!error}
          value={amount}
          onChange={(e) => {
            setAmount(e.target.value)
            if (error) setError('')
          }}
          onKeyDown={onEnter(() => void submit())}
        />
      </div>
      {error && (
        <p className="gerr" role="alert">
          {error}
        </p>
      )}
      <div className="gacts">
        <button type="button" className="btn-acc" disabled={busy} onClick={() => void submit()}>
          Сохранить
        </button>
        <button type="button" className="btn-gray" disabled={busy} onClick={onClose}>
          Отмена
        </button>
      </div>
    </div>
  )
}

type Panel = { kind: 'new' } | { kind: 'edit'; id: string } | null

/*
 * «Лимиты» (spec §4, §6 «форма лимита — поля друг под другом», «В норме / Почти всё / Превышен», «Плавная
 * перерисовка»; prototype limits()): «Добавить» in the bar opens «Новый лимит» on top (pressed again it puts the
 * cursor in the amount); a card per limited expense category — icon and name, the status pill, a thin bar, «$75 из
 * $100 за октябрь» and «Убрать» (binned with «Отменить»). A tap on the name edits the amount in the card. Limits of
 * archived categories are hidden. Blocks re-flow smoothly (useFlip).
 */
export function Limits() {
  const { db, repo, now } = useApp()
  const toast = useToast()
  const [panel, setPanel] = useState<Panel>(null)
  const screenRef = useRef<HTMLDivElement>(null)
  const amountRef = useRef<HTMLInputElement>(null)
  const data = useLiveQuery(async () => {
    const [settings, categories, limits, txs] = await Promise.all([
      db.settings.filter(alive).first(),
      db.categories.filter((c) => alive(c) && !c.archived && c.kind === 'expense').sortBy('sort'),
      db.limits.filter(alive).toArray(),
      db.transactions.filter(alive).toArray(),
    ])
    return { settings, categories, limits, txs }
  }, [db])
  useDayTick(now, data?.settings?.timezone)

  const categories = data?.categories ?? []
  const limitOf = new Map((data?.limits ?? []).map((l) => [l.category_id, l]))
  const shown = categories.flatMap((c) => {
    const limit = limitOf.get(c.id)
    return limit ? [{ category: c, limit }] : []
  })
  const free = categories.filter((c) => !limitOf.has(c.id))
  useFlip(screenRef, [shown.map((r) => r.limit.id).join(','), panel?.kind === 'new' ? 'new' : (panel?.id ?? ''), !!data])

  async function removeLimit(limit: Limit) {
    if (panel?.kind === 'edit' && panel.id === limit.id) setPanel(null)
    try {
      const batch = await repo.remove('limits', limit.id)
      if (batch) toast('Лимит убран', { label: 'Отменить', run: () => repo.restore(batch) })
    } catch {
      toast(FAILED)
    }
  }

  const openNew = () => {
    if (panel?.kind === 'new') amountRef.current?.focus()
    else setPanel({ kind: 'new' })
  }

  const settings = data?.settings
  const month = monthOf(localDate(now(), settings?.timezone ?? 'UTC'))
  const monthName = MONTHS_NOM[Number(month.slice(5, 7)) - 1].toLowerCase()

  return (
    <div ref={screenRef} className="limits">
      <NavBar
        back={{ label: 'Ещё' }}
        title="Лимиты"
        trailing={
          data && settings && free.length > 0 ? (
            <button type="button" className="navbtn strong" onClick={openNew}>
              Добавить
            </button>
          ) : undefined
        }
      />
      {!data ? (
        <p className="muted">Загрузка…</p>
      ) : !settings ? (
        <p className="muted">Сначала завершите настройку</p>
      ) : (
        <>
          {panel?.kind === 'new' && free.length > 0 && (
            <NewLimitCard choices={free} amountRef={amountRef} onClose={() => setPanel(null)} />
          )}
          {shown.map(({ category, limit }) => {
            const status = limitStatus(limit, data.txs, month)
            const editing = panel?.kind === 'edit' && panel.id === limit.id
            return (
              <section key={limit.id} className="card gcard limcard" data-flip-key={`lim-${limit.id}`} aria-label={category.name}>
                <div className="limhead">
                  <button
                    type="button"
                    className="limname"
                    aria-label={`Изменить лимит «${category.name}»`}
                    aria-expanded={editing}
                    onClick={() => setPanel(editing ? null : { kind: 'edit', id: limit.id })}
                  >
                    <CategoryIcon category={category} />
                    <span className="limname-t">{category.name}</span>
                  </button>
                  <span className={`pill ${status.level}`}>{LEVEL[status.level]}</span>
                </div>
                <ProgressBar value={status.share} max={1} level={status.level} thin />
                <div className="limmeta">
                  <span className="num">
                    {usd(status.spentUsd)} <span className="label">{`из ${usd(limit.monthly_usd)} за ${monthName}`}</span>
                  </span>
                  <button
                    type="button"
                    className="textbtn danger"
                    aria-label={`Убрать лимит «${category.name}»`}
                    onClick={() => void removeLimit(limit)}
                  >
                    Убрать
                  </button>
                </div>
                {editing && <EditAmount limit={limit} onClose={() => setPanel(null)} />}
              </section>
            )
          })}
          {shown.length === 0 && panel?.kind !== 'new' && (
            <p className="muted gempty" data-flip-key="empty">
              Лимитов пока нет
            </p>
          )}
          <p className="label gfoot" data-flip-key="foot">
            Бот предупредит, когда потратишь 80% и 100% лимита.
          </p>
        </>
      )}
    </div>
  )
}
