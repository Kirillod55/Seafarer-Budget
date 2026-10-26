import { useState, type ReactNode } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { alive } from '@shared/alive.ts'
import type { Account } from '@shared/types.ts'
import { useApp } from '../context.tsx'

/*
 * The 1.0 management of accounts, moved out of the old settings screen when «Ещё» was redone (Task 10) so nothing
 * is lost meanwhile: «Счета» shows LegacyAccounts (rename, aliases, archive) under the accounts until Task 14.
 */

const SAVE_FAILED = 'Не удалось сохранить'
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
