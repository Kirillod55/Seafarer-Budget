import { useEffect, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { alive } from '@shared/alive.ts'
import { localDate, monthOf } from '@shared/dates.ts'
import type { Category } from '@shared/types.ts'
import { CategoryForm } from '../components/CategoryForm.tsx'
import { useApp } from '../context.tsx'
import { NavBar } from '../nav/NavBar.tsx'
import { useNav } from '../nav/Navigator.tsx'
import { CategoryIcon } from '../ui/CategoryIcon.tsx'
import { plural } from '../ui/dates.ts'
import { SwipeRow, closeOpenSwipeRow, type SwipeAction } from '../ui/SwipeRow.tsx'
import { useToast } from '../ui/Toast.tsx'
import { useFlip } from '../ui/useFlip.ts'
import { useDayTick } from '../ui/useDayTick.ts'
import './categories.css'

const FAILED = 'Не получилось — попробуй ещё раз'
/** Where records without a category go; these two do not swipe (spec §4). */
const OTHER: Record<Category['kind'], string> = { expense: 'Прочее', income: 'Прочий доход' }
const KINDS: [Category['kind'], string][] = [
  ['expense', 'Расходы'],
  ['income', 'Доходы'],
]

const countLine = (n: number) => (n ? plural(n, 'запись', 'записи', 'записей') : 'Нет записей')

/*
 * «Категории» (spec §4 «Категории», §6 «Плавная перерисовка»; prototype cats()): expenses and incomes as lists,
 * the number of records under each name. Swipe left: «Изменить» (the card «Категория»: name, colour, glyph; spec §4,
 * 2026-10-26), «В архив» (grey) and «Удалить» (red) — the row folds away
 * and a toast says «Категория в архиве» or «Категория удалена, записи — в «Прочее»» («Прочий доход» for income);
 * the deleted category's limit goes too, and «Отменить» brings everything back (repo.removeCategory → restore).
 * «Прочее» and «Прочий доход» do not swipe («без категории попадают сюда»). A tap opens the category's records
 * for this month (closing an open row first). «Добавить» opens «Новая категория». Archived categories are hidden.
 */
export function Categories() {
  const { db, repo, now } = useApp()
  const nav = useNav()
  const toast = useToast()
  /** the card on top: «Новая категория» or «Категория» (edit); one at a time */
  const [panel, setPanel] = useState<{ kind: 'new' } | { kind: 'edit'; id: string } | null>(null)
  const screenRef = useRef<HTMLDivElement>(null)
  const data = useLiveQuery(async () => {
    const [settings, categories, txs] = await Promise.all([
      db.settings.filter(alive).first(),
      // not deleted for good: binned ones still count for the name check and the sort (they may come back)
      db.categories.filter((c) => !c.deleted).toArray(),
      db.transactions.filter(alive).toArray(),
    ])
    return { settings, categories, txs }
  }, [db])
  useDayTick(now, data?.settings?.timezone)

  const shown = (data?.categories ?? []).filter((c) => alive(c) && !c.archived).sort((a, b) => a.sort - b.sort)
  const ids = shown.map((c) => c.id).join(',')
  const editing = panel?.kind === 'edit' ? shown.find((c) => c.id === panel.id) : undefined
  const panelKey = panel?.kind === 'new' ? 'new' : (editing?.id ?? '')
  useFlip(screenRef, [ids, panelKey, !!data])

  // rows that come back (an «Отменить») or are new slide in; the first list does not
  const seen = useRef<Set<string> | null>(null)
  useEffect(() => {
    if (data) seen.current = new Set(shown.map((c) => c.id))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids, !!data])

  const counts = new Map<string, number>()
  for (const t of data?.txs ?? []) if (t.category_id) counts.set(t.category_id, (counts.get(t.category_id) ?? 0) + 1)

  const open = (c: Category) => {
    const month = monthOf(localDate(now(), data?.settings?.timezone ?? 'UTC'))
    nav.push({ tab: nav.route.tab, screen: 'records', category: c.id, month, from: 'cats' })
  }

  async function archive(c: Category) {
    try {
      await repo.put<Category>('categories', { id: c.id, archived: true })
      toast('Категория в архиве', { label: 'Отменить', run: () => repo.put<Category>('categories', { id: c.id, archived: false }) })
    } catch {
      toast(FAILED)
    }
  }

  async function remove(c: Category) {
    try {
      const batch = await repo.removeCategory(c.id)
      if (batch) toast(`Категория удалена, записи — в «${OTHER[c.kind]}»`, { label: 'Отменить', run: () => repo.restore(batch) })
      // the repo refused: the category is already gone (deleted elsewhere meanwhile) or is «Прочее» itself
      else toast(c.name === OTHER[c.kind] ? `«${c.name}» удалить нельзя` : 'Категория уже удалена')
    } catch {
      toast(FAILED)
    }
  }

  const row = (c: Category) => {
    const cnt = countLine(counts.get(c.id) ?? 0)
    const body = (sub: string) => (
      <>
        <CategoryIcon category={c} />
        <span className="t">
          <span className="t1">{c.name}</span>
          <span className="t2">{sub}</span>
        </span>
      </>
    )
    if (c.name === OTHER[c.kind]) {
      return (
        <div key={c.id} className="swipe">
          <button
            type="button"
            className="tx crow fixed"
            onClick={() => {
              if (!closeOpenSwipeRow()) open(c)
            }}
          >
            {body(`${cnt} · без категории попадают сюда`)}
          </button>
        </div>
      )
    }
    const actions: SwipeAction[] = [
      { key: 'edit', label: 'Изменить', run: () => setPanel({ kind: 'edit', id: c.id }) },
      { key: 'archive', label: 'В архив', run: () => void archive(c) },
      { key: 'delete', label: 'Удалить', run: () => void remove(c) },
    ]
    const fresh = seen.current !== null && !seen.current.has(c.id)
    return (
      <SwipeRow key={c.id} actions={actions} onOpen={() => open(c)} className={`crow${fresh ? ' row-in' : ''}`}>
        {body(cnt)}
      </SwipeRow>
    )
  }

  return (
    <div ref={screenRef} className="cats">
      <NavBar
        back={{ label: 'Ещё' }}
        title="Категории"
        trailing={
          panel?.kind === 'new' || editing ? undefined : (
            <button type="button" className="navbtn strong" onClick={() => setPanel({ kind: 'new' })}>
              Добавить
            </button>
          )
        }
      />
      {!data ? (
        <p className="muted">Загрузка…</p>
      ) : (
        <>
          {panel?.kind === 'new' && <CategoryForm categories={data.categories} onClose={() => setPanel(null)} />}
          {editing && (
            <CategoryForm key={editing.id} categories={data.categories} category={editing} onClose={() => setPanel(null)} />
          )}
          {KINDS.map(([kind, title]) => {
            const list = shown.filter((c) => c.kind === kind)
            return (
              <section key={kind} className="cat-sec" data-flip-key={`sec-${kind}`} aria-label={title}>
                <h2 className="section">{title}</h2>
                {list.length > 0 && <div className="group">{list.map(row)}</div>}
              </section>
            )
          })}
          <p className="label cat-foot" data-flip-key="foot">
            Смахни категорию влево, чтобы изменить её, убрать в архив или удалить. Записи удалённой категории перейдут в
            «Прочее». Архив — в «Ещё» → «Архив».
          </p>
        </>
      )}
    </div>
  )
}
