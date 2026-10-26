import { useState, type ReactNode } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { alive } from '@shared/alive.ts'
import type { Account, Category } from '@shared/types.ts'
import { useApp } from '../context.tsx'

/*
 * The 1.0 management of categories and accounts, moved out of the old settings screen when «Ещё» was redone
 * (Task 10) so nothing is lost meanwhile: «Категории» shows LegacyCategories until Task 11 builds the new screen;
 * «Счета» shows LegacyAccounts (rename, aliases, archive) under the accounts until Task 14 redoes them.
 */

const SAVE_FAILED = 'Не удалось сохранить'
const DEFAULT_ICON = '🏷️'
/** Runs a save: `busy` while it works, `error` («Не удалось сохранить») when it throws. Resolves to success. */
function useAction() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function run(fn: () => Promise<void>): Promise<boolean> {
    setBusy(true)
    setError('')
    try {
      await fn()
      return true
    } catch {
      setError(SAVE_FAILED)
      return false
    } finally {
      setBusy(false)
    }
  }
  return { busy, error, setError, run }
}

function ErrorLine({ children }: { children: ReactNode }) {
  return children ? (
    <p className="error" role="alert">
      {children}
    </p>
  ) : null
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="card stack" aria-label={title}>
      <h2>{title}</h2>
      {children}
    </section>
  )
}

const byName = (a: { sort: number }, b: { sort: number }) => a.sort - b.sort
const nextSort = (rows: { sort: number }[]) => rows.reduce((max, r) => Math.max(max, r.sort), -1) + 1
/* ---------- categories ---------- */

function CategoryForm({
  category,
  categories,
  onClose,
}: {
  category: Category | null
  categories: Category[]
  onClose(): void
}) {
  const { repo } = useApp()
  const { busy, error, setError, run } = useAction()
  const [name, setName] = useState(category?.name ?? '')
  const [kind, setKind] = useState<Category['kind']>(category?.kind ?? 'expense')
  const [icon, setIcon] = useState(category?.icon ?? '')

  async function save() {
    if (!name.trim()) return setError('Введите название')
    const saved = await run(async () => {
      const common = { name: name.trim(), icon: icon.trim() || DEFAULT_ICON }
      if (category) {
        await repo.put<Category>('categories', { id: category.id, ...common })
      } else {
        await repo.put<Category>('categories', {
          ...common,
          kind,
          keywords: [],
          archived: false,
          sort: nextSort(categories),
        })
      }
    })
    if (saved) onClose()
  }

  return (
    <form
      className="card stack"
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
    >
      <h2>{category ? 'Категория' : 'Новая категория'}</h2>
      <div>
        <label htmlFor="cat-name">Название категории</label>
        <input id="cat-name" className="field" type="text" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      {!category && (
        <div>
          <label htmlFor="cat-kind">Тип</label>
          <select id="cat-kind" className="field" value={kind} onChange={(e) => setKind(e.target.value as Category['kind'])}>
            <option value="expense">Расход</option>
            <option value="income">Доход</option>
          </select>
        </div>
      )}
      <div>
        <label htmlFor="cat-icon">Иконка</label>
        <input
          id="cat-icon"
          className="field"
          type="text"
          autoComplete="off"
          placeholder={DEFAULT_ICON}
          value={icon}
          onChange={(e) => setIcon(e.target.value)}
        />
      </div>
      <ErrorLine>{error}</ErrorLine>
      <div className="row">
        <button type="submit" className="btn btn-primary grow" disabled={busy}>
          Сохранить категорию
        </button>
        <button type="button" className="btn" disabled={busy} onClick={onClose}>
          Отмена
        </button>
      </div>
    </form>
  )
}

type CategoryEditing = { id: string } | 'new' | null

function CategoriesSection({ categories }: { categories: Category[] }) {
  const { repo } = useApp()
  const { busy, error, run } = useAction()
  const [editing, setEditing] = useState<CategoryEditing>(null)

  if (editing) {
    const category = editing === 'new' ? null : (categories.find((c) => c.id === editing.id) ?? null)
    return <CategoryForm category={category} categories={categories} onClose={() => setEditing(null)} />
  }

  const setArchived = (c: Category, archived: boolean) =>
    run(async () => {
      await repo.put<Category>('categories', { id: c.id, archived })
    })

  return (
    <Section title="Категории">
      {(
        [
          ['expense', 'Расходы'],
          ['income', 'Доходы'],
        ] as const
      ).map(([kind, title]) => (
        <div key={kind}>
          <h3 className="label">{title}</h3>
          <ul className="set-list">
            {categories
              .filter((c) => c.kind === kind)
              .sort(byName)
              .map((c) => (
                <li key={c.id} className={`set-row${c.archived ? ' archived' : ''}`}>
                  <span className="set-icon" aria-hidden="true">
                    {c.icon}
                  </span>
                  <span className="set-name">
                    {c.name}
                    {c.archived && <span className="muted small">{' · в архиве'}</span>}
                  </span>
                  <button
                    type="button"
                    className="btn btn-link"
                    aria-label={`Изменить категорию ${c.name}`}
                    disabled={busy}
                    onClick={() => setEditing({ id: c.id })}
                  >
                    Изменить
                  </button>
                  <button
                    type="button"
                    className="btn btn-link"
                    aria-label={`${c.archived ? 'Вернуть' : 'Архивировать'} категорию ${c.name}`}
                    disabled={busy}
                    onClick={() => void setArchived(c, !c.archived)}
                  >
                    {c.archived ? 'Вернуть' : 'В архив'}
                  </button>
                </li>
              ))}
          </ul>
        </div>
      ))}
      <ErrorLine>{error}</ErrorLine>
      <button type="button" className="btn" onClick={() => setEditing('new')}>
        + Категория
      </button>
    </Section>
  )
}

/* ---------- accounts management ---------- */

function AccountForm({ account, onClose }: { account: Account; onClose(): void }) {
  const { repo } = useApp()
  const { busy, error, setError, run } = useAction()
  const [name, setName] = useState(account.name)
  const [aliases, setAliases] = useState(account.aliases.join(', '))

  async function save() {
    if (!name.trim()) return setError('Введите название')
    const saved = await run(async () => {
      await repo.put<Account>('accounts', {
        id: account.id,
        name: name.trim(),
        aliases: aliases
          .split(',')
          .map((a) => a.trim())
          .filter(Boolean),
      })
    })
    if (saved) onClose()
  }

  return (
    <form
      className="card stack"
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
    >
      <h2>Счёт</h2>
      <div>
        <label htmlFor="acc-edit-name">Название счёта</label>
        <input id="acc-edit-name" className="field" type="text" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div>
        <label htmlFor="acc-edit-aliases">Псевдонимы (через запятую)</label>
        <input
          id="acc-edit-aliases"
          className="field"
          type="text"
          value={aliases}
          onChange={(e) => setAliases(e.target.value)}
        />
      </div>
      <ErrorLine>{error}</ErrorLine>
      <div className="row">
        <button type="submit" className="btn btn-primary grow" disabled={busy}>
          Сохранить счёт
        </button>
        <button type="button" className="btn" disabled={busy} onClick={onClose}>
          Отмена
        </button>
      </div>
    </form>
  )
}

function AccountsSection({ accounts }: { accounts: Account[] }) {
  const { repo } = useApp()
  const { busy, error, run } = useAction()
  const [editingId, setEditingId] = useState<string | null>(null)
  const editing = accounts.find((a) => a.id === editingId)
  if (editing) return <AccountForm account={editing} onClose={() => setEditingId(null)} />

  const activeCount = accounts.filter((a) => !a.archived).length
  const setArchived = (a: Account, archived: boolean) =>
    run(async () => {
      await repo.put<Account>('accounts', { id: a.id, archived })
    })

  return (
    <Section title="Управление счетами">
      <ul className="set-list">
        {[...accounts].sort(byName).map((a) => {
          // the default account stays, and so does the last active one
          const cannotArchive = !a.archived && (a.is_default || activeCount <= 1)
          return (
            <li key={a.id} className={`set-row${a.archived ? ' archived' : ''}`}>
              <span className="set-name">
                {a.name}
                {a.is_default && <span className="muted small">{' · основной'}</span>}
                {a.archived && <span className="muted small">{' · в архиве'}</span>}
                {a.aliases.length > 0 && <span className="muted small set-sub">{a.aliases.join(', ')}</span>}
              </span>
              <button
                type="button"
                className="btn btn-link"
                aria-label={`Изменить счёт ${a.name}`}
                disabled={busy}
                onClick={() => setEditingId(a.id)}
              >
                Изменить
              </button>
              <button
                type="button"
                className="btn btn-link"
                aria-label={`${a.archived ? 'Вернуть' : 'Архивировать'} счёт ${a.name}`}
                disabled={busy || cannotArchive}
                onClick={() => void setArchived(a, !a.archived)}
              >
                {a.archived ? 'Вернуть' : 'В архив'}
              </button>
            </li>
          )
        })}
      </ul>
      <ErrorLine>{error}</ErrorLine>
    </Section>
  )
}

/** «Категории» until Task 11: the 1.0 list with rename, icon, archive and «+ Категория». */
export function LegacyCategories() {
  const { db } = useApp()
  const categories = useLiveQuery(() => db.categories.filter(alive).toArray(), [db])
  if (!categories) return <p className="muted pad">Загрузка…</p>
  return (
    <div className="stack">
      <CategoriesSection categories={categories} />
    </div>
  )
}

/** «Управление счетами» (multi mode only) until Task 14: rename, aliases, archive. */
export function LegacyAccounts() {
  const { db } = useApp()
  const data = useLiveQuery(async () => {
    const [settings, accounts] = await Promise.all([db.settings.filter(alive).first(), db.accounts.filter(alive).toArray()])
    return { settings, accounts }
  }, [db])
  if (!data?.settings || data.settings.accounts_mode !== 'multi') return null
  return <AccountsSection accounts={data.accounts} />
}
