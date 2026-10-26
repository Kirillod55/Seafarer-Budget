import { useRef, useState, type CSSProperties, type ReactElement, type ReactNode } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { alive } from '@shared/alive.ts'
import { balanceUsd, balances, goalProgress } from '@shared/calc.ts'
import { localDate } from '@shared/dates.ts'
import { money } from '@shared/format.ts'
import type { Account, Category, Goal, Transaction } from '@shared/types.ts'
import { KIND_TITLE, amounts, capitalize } from '../components/TxRow.tsx'
import { useApp } from '../context.tsx'
import { bareCategory } from '../lib/records.ts'
import { EMPTY_BALANCE } from '../db/repo.ts'
import { NavBar } from '../nav/NavBar.tsx'
import { useRoute } from '../nav/Navigator.tsx'
import { CategoryIcon } from '../ui/CategoryIcon.tsx'
import { dayMonth, plural } from '../ui/dates.ts'
import { CreditCard, Target } from '../ui/icons.ts'
import { useToast } from '../ui/Toast.tsx'
import { useFlip } from '../ui/useFlip.ts'
import { useDayTick } from '../ui/useDayTick.ts'
import './record.css'
import './archive.css'

const FAILED = 'Не получилось — попробуй ещё раз'
const OTHER: Record<Category['kind'], string> = { expense: 'Прочее', income: 'Прочий доход' }

/** The archive key of a row: its kind and id («t:…», «g:…», «c:…», «a:…»), as in the prototype. */
type Key = `${'t' | 'g' | 'c' | 'a'}:${string}`

/*
 * «Архив» (spec §4 «Ещё → Архив», §6 «Плавная перерисовка»; prototype archive()): everything put away on one screen —
 * «Записи» (category · note, date and amount), «Цели» (saved of target, «достигнута»), «Категории» (expense/income,
 * records), «Счета» (balance). Each row has «Вернуть» and «Удалить» under its name; «Удалить» first asks on a line
 * under the row, then deletes with «Отменить» in the toast: records and goals go to the 24 h bin (repo.remove →
 * restore), a category's records move to «Прочее» (repo.removeCategory → restore). An account can be deleted only
 * when it is empty («Остаток $0»); its `deleted = true` is final on the server, so it is written only when the toast
 * goes without «Отменить» (ToastAction.expire) — until then the row is just hidden here.
 * Reached from «Ещё» («Архив · N») and from «Цели» («Архив целей · N»): the back pill names that tab.
 */
export function Archive() {
  const { db, repo, now } = useApp()
  const route = useRoute()
  const toast = useToast()
  const screenRef = useRef<HTMLDivElement>(null)
  const [confirm, setConfirm] = useState<Key | null>(null)
  /** empty accounts deleted here whose «Отменить» is still on offer */
  const [leaving, setLeaving] = useState<ReadonlySet<string>>(new Set())

  const data = useLiveQuery(async () => {
    const [settings, txs, goals, moves, categories, accounts, rates] = await Promise.all([
      db.settings.filter(alive).first(),
      db.transactions.filter(alive).toArray(),
      db.goals.filter(alive).toArray(),
      db.goal_moves.filter(alive).toArray(),
      db.categories.filter(alive).toArray(),
      db.accounts.filter(alive).toArray(),
      db.fx_rates.toArray(),
    ])
    return { settings, txs, goals, moves, categories, accounts, rates }
  }, [db])
  useDayTick(now, data?.settings?.timezone)

  const today = localDate(now(), data?.settings?.timezone ?? 'UTC')
  const txs = (data?.txs ?? [])
    .filter((t) => t.archived)
    .sort((a, b) => (a.date === b.date ? b.created_at.localeCompare(a.created_at) : a.date < b.date ? 1 : -1))
  const goals = (data?.goals ?? []).filter((g) => g.archived)
  const categories = (data?.categories ?? []).filter((c) => c.archived).sort((a, b) => a.sort - b.sort)
  const accounts = (data?.accounts ?? []).filter((a) => a.archived && !leaving.has(a.id)).sort((a, b) => a.sort - b.sort)

  const ids = [txs, goals, categories, accounts].map((rows) => rows.map((r) => r.id).join(',')).join('|')
  useFlip(screenRef, [ids, confirm, !!data])

  const catById = new Map((data?.categories ?? []).map((c) => [c.id, c]))
  // every live record counts (archived ones too) — as on «Категории»
  const counts = new Map<string, number>()
  for (const t of data?.txs ?? []) if (t.category_id) counts.set(t.category_id, (counts.get(t.category_id) ?? 0) + 1)

  /** runs a write; a failure says so */
  const attempt = async (work: () => Promise<unknown>) => {
    try {
      await work()
    } catch {
      toast(FAILED)
    }
  }

  const back = (key: Key, run: () => Promise<unknown>, said: string) =>
    attempt(async () => {
      await run()
      setConfirm((k) => (k === key ? null : k))
      toast(said)
    })

  const unarchive = {
    tx: (t: Transaction) => back(`t:${t.id}`, () => repo.setArchived(t.id, false), 'Запись вернулась'),
    goal: (g: Goal) => back(`g:${g.id}`, () => repo.put<Goal>('goals', { id: g.id, archived: false }), 'Цель вернулась'),
    category: (c: Category) =>
      back(`c:${c.id}`, () => repo.put<Category>('categories', { id: c.id, archived: false }), 'Категория вернулась'),
    account: (a: Account) =>
      back(`a:${a.id}`, () => repo.put<Account>('accounts', { id: a.id, archived: false }), 'Счёт вернулся'),
  }

  /** a record or a goal into the 24 h bin */
  const binned = (table: 'transactions' | 'goals', id: string, said: string) =>
    attempt(async () => {
      setConfirm(null)
      const batch = await repo.remove(table, id)
      if (batch) toast(said, { label: 'Отменить', run: () => repo.restore(batch) })
    })

  const remove = {
    tx: (t: Transaction) => binned('transactions', t.id, 'Запись удалена'),
    goal: (g: Goal) => binned('goals', g.id, 'Цель удалена'),
    category: (c: Category) =>
      attempt(async () => {
        setConfirm(null)
        const batch = await repo.removeCategory(c.id)
        if (batch) toast(`Категория удалена, записи — в «${OTHER[c.kind]}»`, { label: 'Отменить', run: () => repo.restore(batch) })
        else toast(c.name === OTHER[c.kind] ? `«${c.name}» удалить нельзя` : 'Категория уже удалена')
      }),
    account: (a: Account) => {
      setConfirm(null)
      const keep = (on: boolean) =>
        setLeaving((s) => {
          const next = new Set(s)
          if (on) next.add(a.id)
          else next.delete(a.id)
          return next
        })
      keep(true)
      toast('Счёт удалён', {
        label: 'Отменить',
        run: () => keep(false),
        // the repo checks the account again when it writes: still archived, not the main one, nothing on it (a record
        // may have come in meanwhile, or it was returned after re-opening this screen). Deleted: it stays hidden (the
        // live query drops it); refused: it shows again; a failed write shows it again and says so.
        expire: () =>
          void repo.removeEmptyAccount(a.id).then(
            (done) => {
              if (!done) keep(false)
            },
            () => {
              keep(false)
              toast(FAILED)
            },
          ),
      })
    },
  }

  /** A row: tile, name and line under it, «Вернуть» / «Удалить», and the confirm line when asked. */
  const row = (
    key: Key,
    p: { icon: ReactNode; name: string; sub: string; onBack(): void; onDelete?(): void; ask: string },
  ) => (
    <div key={key} className="aitem" data-flip-key={key}>
      <div className="arow">
        {p.icon}
        <span className="nm">
          <b>{p.name}</b>
          <span className="label num">{p.sub}</span>
        </span>
        <span className="aacts">
          <button type="button" className="textbtn" onClick={p.onBack}>
            Вернуть
          </button>
          {p.onDelete && (
            <button
              type="button"
              className="textbtn danger"
              aria-expanded={confirm === key}
              onClick={() => setConfirm((k) => (k === key ? null : key))}
            >
              Удалить
            </button>
          )}
        </span>
      </div>
      {confirm === key && p.onDelete && (
        <div className="arconf reveal">
          <span className="label">{p.ask}</span>
          <button type="button" className="btn-gray danger" onClick={p.onDelete}>
            Удалить
          </button>
          <button type="button" className="btn-gray" onClick={() => setConfirm(null)}>
            Нет
          </button>
        </div>
      )}
    </div>
  )

  const tile = (Icon: typeof Target) => (
    <span className="ic" style={{ '--c': 'var(--anchor)' } as CSSProperties} aria-hidden="true">
      <Icon strokeWidth={2} />
    </span>
  )

  const year = today.slice(0, 4)
  const txRows = txs.map((t) => {
    const category = t.category_id ? catById.get(t.category_id) : undefined
    const title = category?.name ?? KIND_TITLE[t.kind]
    const note = capitalize(t.note.trim())
    const date = dayMonth(t.date) + (t.date.slice(0, 4) !== year ? ` ${t.date.slice(0, 4)}` : '')
    return row(`t:${t.id}`, {
      icon: <CategoryIcon category={category ?? bareCategory(title)} />,
      name: note ? `${title} · ${note}` : title,
      sub: `${date} · ${amounts(t).main}`,
      onBack: () => void unarchive.tx(t),
      onDelete: () => void remove.tx(t),
      ask: 'Удалить эту запись навсегда?',
    })
  })

  const goalRows = goals.map((g) => {
    const saved = goalProgress(g, data?.moves ?? [], today).savedUsd
    const done = g.target_usd > 0 && saved >= g.target_usd
    return row(`g:${g.id}`, {
      icon: tile(Target),
      name: g.name,
      sub: `${money(saved, 'USD', { whole: true })} из ${money(g.target_usd, 'USD', { whole: true })}${done ? ' · достигнута' : ''}`,
      onBack: () => void unarchive.goal(g),
      onDelete: () => void remove.goal(g),
      ask: `Удалить цель «${g.name}» навсегда?`,
    })
  })

  const categoryRows = categories.map((c) => {
    const k = counts.get(c.id) ?? 0
    return row(`c:${c.id}`, {
      icon: <CategoryIcon category={c} />,
      name: c.name,
      sub: `${c.kind === 'income' ? 'Доход' : 'Расход'} · ${k ? plural(k, 'запись', 'записи', 'записей') : 'записей нет'}`,
      onBack: () => void unarchive.category(c),
      onDelete: c.name === OTHER[c.kind] ? undefined : () => void remove.category(c),
      ask: `${k ? `Записи (${k}) перейдут в «${OTHER[c.kind]}». ` : ''}Удалить «${c.name}»?`,
    })
  })

  const accountRows = accounts.map((a) => {
    const bal = balances(data?.txs ?? [], a.id)
    const empty = Object.values(bal).every((v) => Math.abs(v) < EMPTY_BALANCE)
    return row(`a:${a.id}`, {
      icon: tile(CreditCard),
      name: a.name,
      sub: empty
        ? a.is_default
          ? 'Остаток $0 — основной счёт удалить нельзя'
          : 'Остаток $0'
        : `Остаток ≈ ${money(balanceUsd(bal, data?.rates ?? [], today), 'USD', { whole: true })} — удалить можно пустой счёт`,
      onBack: () => void unarchive.account(a),
      // the main account is never deleted (spec §9)
      onDelete: empty && !a.is_default ? () => remove.account(a) : undefined,
      ask: `Удалить счёт «${a.name}» навсегда?`,
    })
  })

  const section = (key: string, title: string, rows: ReactElement[]) => (
    <Section key={key} id={key} title={title} rows={rows} confirm={confirm} />
  )

  return (
    <div ref={screenRef} className="archive">
      <NavBar back={{ label: route.tab === 'goals' ? 'Цели' : 'Ещё' }} title="Архив" />
      {!data ? (
        <p className="muted">Загрузка…</p>
      ) : (
        <>
          <p className="label arch-intro" data-flip-key="intro">
            Здесь то, что ты убрал с глаз. Архивные цели, категории и счета не участвуют в бюджете. Архивные записи
            скрыты из списков, но их сумма остаётся в балансе и отчётах. Вернуть можно в любой момент.
          </p>
          {section('t', 'Записи', txRows)}
          {section('g', 'Цели', goalRows)}
          {section('c', 'Категории', categoryRows)}
          {section('a', 'Счета', accountRows)}
        </>
      )}
    </div>
  )
}

/**
 * One section: its rows are blocks of their own (data-flip-key = the row key), so a row that is returned or deleted
 * melts where it stood while the rows under it slide up, and the confirm line opens smoothly; the section itself is a
 * block of the screen (its height follows).
 */
function Section({ id, title, rows, confirm }: { id: string; title: string; rows: ReactElement[]; confirm: Key | null }) {
  const cardRef = useRef<HTMLDivElement>(null)
  const keys = rows.map((r) => String(r.key)).join(',')
  useFlip(cardRef, [keys, confirm])
  return (
    <section className="arch-sec" data-flip-key={`sec-${id}`} aria-label={title}>
      <h2 className="section">{title}</h2>
      <div ref={cardRef} className="group">
        {rows.length ? (
          rows
        ) : (
          <div className="arow aempty" data-flip-key="empty">
            <span className="label">Пусто</span>
          </div>
        )}
      </div>
    </section>
  )
}
