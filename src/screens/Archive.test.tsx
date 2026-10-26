import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Account, Category, Goal, Transaction } from '@shared/types.ts'
import type { AppContextValue } from '../context.tsx'
import { Navigator, useNav, type Route } from '../nav/Navigator.tsx'
import { TEST_TODAY, makeEnv, renderWithApp } from '../test-utils.tsx'
import { ToastHost } from '../ui/Toast.tsx'
import { Archive } from './Archive.tsx'
import { Goals } from './Goals.tsx'
import { Home } from './Home.tsx'
import { More } from './More.tsx'
import { RecordSheetHost } from './RecordSheet.tsx'

let env: AppContextValue
let main: Account
const cat: Record<string, Category> = {}

/** Reduce Motion on: nothing waits for an animation. */
function reducedMotion() {
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: q.includes('prefers-reduced-motion: reduce'),
    media: q,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  }))
}

const spend = (note: string, opts: { amount?: number; account?: string; category?: string; archived?: boolean; kind?: Transaction['kind'] } = {}) =>
  env.repo.addTransaction({
    kind: opts.kind ?? 'expense',
    amount: opts.amount ?? 12.5,
    currency: 'USD',
    account_id: opts.account ?? main.id,
    to_account_id: null,
    to_amount: null,
    to_currency: null,
    category_id: cat[opts.category ?? 'Кафе и рестораны']?.id ?? null,
    date: TEST_TODAY,
    note,
    source: 'app',
    archived: opts.archived ?? false,
  })

const addAccount = (name: string, archived = true) =>
  env.repo.put<Account>('accounts', { name, aliases: [], is_default: false, archived, sort: 5 })

/** A button on the home screen that opens the archive (as «Ещё» does). */
function ToArchive() {
  const nav = useNav()
  return (
    <button type="button" onClick={() => nav.push({ tab: 'more', screen: 'archive' })}>
      в архив
    </button>
  )
}

function renderApp(start: 'home' | 'more' = 'home') {
  return renderWithApp(
    <RecordSheetHost>
      <Navigator
        renderScreen={(r: Route) =>
          r.screen === 'archive' ? (
            <Archive />
          ) : r.tab === 'more' ? (
            <More onSignOut={() => {}} />
          ) : (
            <>
              <ToArchive />
              {start === 'home' && <Home />}
            </>
          )
        }
      />
      <ToastHost />
    </RecordSheetHost>,
    env,
  )
}

async function openArchive() {
  renderApp()
  fireEvent.click(await screen.findByRole('button', { name: 'в архив' }))
  await screen.findByRole('heading', { level: 1, name: 'Архив' })
}

/** An archive row by its title text. */
async function rowOf(text: string): Promise<HTMLElement> {
  return waitFor(() => {
    const el = [...document.querySelectorAll<HTMLElement>('.archive .aitem')].find((e) =>
      e.querySelector('.nm b')?.textContent?.includes(text),
    )
    if (!el) throw new Error(`no row «${text}»`)
    return el
  })
}

const toastText = () => document.querySelector('.toast')?.textContent ?? ''

beforeEach(async () => {
  env = makeEnv()
  reducedMotion()
  await env.repo.initDefaults('single', [])
  main = (await env.db.accounts.toCollection().first())!
  for (const c of await env.db.categories.toArray()) cat[c.name] = c
})

describe('Archive', () => {
  it('an archived expense: «Вернуть» brings it back to the home list', async () => {
    await spend('Капучино на вахте', { archived: true })
    await openArchive()
    const row = await rowOf('Кафе и рестораны · Капучино на вахте')
    expect(row.textContent).toContain('21 октября')
    expect(row.textContent).toContain('$12.50')
    fireEvent.click(within(row).getByRole('button', { name: 'Вернуть' }))
    await waitFor(() => expect(toastText()).toContain('Запись вернулась'))
    await waitFor(async () => expect((await env.db.transactions.toArray()).every((t) => !t.archived)).toBe(true))
    // the records section is empty now
    await waitFor(() => expect(screen.getByRole('region', { name: 'Записи' }).textContent).toContain('Пусто'))
    fireEvent.click(screen.getByRole('button', { name: 'Назад, Ещё' }))
    await waitFor(() => expect(screen.getByText('Капучино на вахте')).toBeTruthy())
  })

  it('an account with money on it cannot be deleted, only returned; an empty one can', async () => {
    const full = await addAccount('Монобанк')
    await spend('Зарплата', { kind: 'income', amount: 40, account: full.id, category: 'Зарплата' })
    const empty = await addAccount('Наличные')
    await openArchive()
    const fullRow = await rowOf('Монобанк')
    expect(fullRow.textContent).toContain('Остаток ≈ $40')
    expect(fullRow.textContent).toContain('удалить можно пустой счёт')
    expect(within(fullRow).queryByRole('button', { name: 'Удалить' })).toBeNull()
    expect(within(fullRow).getByRole('button', { name: 'Вернуть' })).toBeTruthy()

    const emptyRow = await rowOf('Наличные')
    expect(emptyRow.textContent).toContain('Остаток $0')
    fireEvent.click(within(emptyRow).getByRole('button', { name: 'Удалить' }))
    expect(emptyRow.textContent).toContain('Удалить счёт «Наличные» навсегда?')
    fireEvent.click(within(emptyRow).getByRole('button', { name: 'Нет' }))
    expect(emptyRow.textContent).not.toContain('навсегда?')

    fireEvent.click(within(emptyRow).getByRole('button', { name: 'Удалить' }))
    fireEvent.click(within(emptyRow).getAllByRole('button', { name: 'Удалить' }).at(-1)!)
    await waitFor(() => expect(toastText()).toContain('Счёт удалён'))
    // gone from the screen at once; the final deletion waits until «Отменить» is no longer offered
    await waitFor(() => expect(screen.getByRole('region', { name: 'Счета' }).textContent).not.toContain('Наличные'))
    expect((await env.db.accounts.get(empty.id))!.deleted).toBe(false)
    fireEvent.click(await screen.findByRole('button', { name: 'Отменить' }))
    await rowOf('Наличные')
    expect((await env.db.accounts.get(empty.id))!.deleted).toBe(false)
  })

  it('an empty account is deleted for good once the toast goes without «Отменить»', async () => {
    const empty = await addAccount('Наличные')
    await openArchive()
    const row = await rowOf('Наличные')
    fireEvent.click(within(row).getByRole('button', { name: 'Удалить' }))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      fireEvent.click(within(row).getAllByRole('button', { name: 'Удалить' }).at(-1)!)
      expect(toastText()).toContain('Счёт удалён')
      act(() => void vi.advanceTimersByTime(6100))
    } finally {
      vi.useRealTimers()
    }
    await waitFor(async () => expect((await env.db.accounts.get(empty.id))!.deleted).toBe(true))
    expect(screen.getByRole('region', { name: 'Счета' }).textContent).toContain('Пусто')
  })

  it('a record that lands on the account before the toast goes keeps it (shown again, not deleted)', async () => {
    const acc = await addAccount('Наличные')
    await openArchive()
    const row = await rowOf('Наличные')
    fireEvent.click(within(row).getByRole('button', { name: 'Удалить' }))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      fireEvent.click(within(row).getAllByRole('button', { name: 'Удалить' }).at(-1)!)
      expect(toastText()).toContain('Счёт удалён')
      // the bot writes Маша's expense onto it meanwhile
      await spend('Синхронизировано', { account: acc.id, amount: 7 })
      act(() => void vi.advanceTimersByTime(6100))
    } finally {
      vi.useRealTimers()
    }
    const back = await rowOf('Наличные')
    await waitFor(() => expect(back.textContent).toContain('удалить можно пустой счёт'))
    expect((await env.db.accounts.get(acc.id))!.deleted).toBe(false)
  })

  it('«Вернуть» after re-opening the archive: the replaced «Счёт удалён» toast does not delete the account', async () => {
    const acc = await addAccount('Наличные')
    await openArchive()
    const row = await rowOf('Наличные')
    fireEvent.click(within(row).getByRole('button', { name: 'Удалить' }))
    fireEvent.click(within(row).getAllByRole('button', { name: 'Удалить' }).at(-1)!)
    await waitFor(() => expect(toastText()).toContain('Счёт удалён'))
    // leave and come back while «Отменить» is still offered: the account is listed again
    fireEvent.click(screen.getByRole('button', { name: 'Назад, Ещё' }))
    fireEvent.click(await screen.findByRole('button', { name: 'в архив' }))
    const again = await rowOf('Наличные')
    fireEvent.click(within(again).getByRole('button', { name: 'Вернуть' }))
    await waitFor(() => expect(toastText()).toContain('Счёт вернулся'))
    await new Promise((r) => setTimeout(r, 50))
    expect(await env.db.accounts.get(acc.id)).toMatchObject({ deleted: false, archived: false })
  })

  it('an empty main account says why it has no «Удалить»', async () => {
    await env.repo.put<Account>('accounts', { id: main.id, archived: true })
    await openArchive()
    const row = await rowOf('Основной')
    expect(row.textContent).toContain('Остаток $0 — основной счёт удалить нельзя')
    expect(within(row).queryByRole('button', { name: 'Удалить' })).toBeNull()
  })

  it('«Архив целей · N» on «Цели» equals the archive’s «Цели» section', async () => {
    await env.repo.put<Goal>('goals', { name: 'Машина', target_usd: 100, deadline: null, archived: true })
    await env.repo.put<Goal>('goals', { name: 'Отпуск', target_usd: 500, deadline: null, archived: true })
    await env.repo.put<Goal>('goals', { name: 'Дом', target_usd: 900, deadline: null, archived: false })
    const binned = await env.repo.put<Goal>('goals', { name: 'Старая', target_usd: 50, deadline: null, archived: true })
    await env.repo.remove('goals', binned.id)
    renderWithApp(
      <>
        <Navigator renderScreen={(r: Route) => (r.screen === 'archive' ? <Archive /> : r.tab === 'goals' ? <Goals /> : <p>home</p>)} />
        <ToastHost />
      </>,
      env,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Цели' }))
    const link = await screen.findByRole('button', { name: /^Архив целей · \d+$/ })
    const n = Number(link.textContent!.split(' · ')[1])
    fireEvent.click(link)
    const sec = await screen.findByRole('region', { name: 'Цели' })
    await waitFor(() => expect(sec.querySelectorAll('.aitem')).toHaveLength(n))
    expect(n).toBe(2)
  })

  it('«Архив · N» in «Ещё» equals the number of rows in the archive', async () => {
    await spend('Чай', { archived: true })
    await spend('Не в архиве')
    const binned = await spend('В корзине', { archived: true })
    await env.repo.remove('transactions', binned.id)
    await env.repo.put<Goal>('goals', { name: 'Машина', target_usd: 100, deadline: null, archived: true })
    await env.repo.put<Category>('categories', { id: cat['Кафе и рестораны'].id, archived: true })
    await addAccount('Наличные')
    renderApp('more')
    fireEvent.click(document.querySelector<HTMLButtonElement>('.tabs .tab:last-child')!)
    const link = await screen.findByRole('button', { name: /^Архив · \d+$/ })
    const n = Number(link.getAttribute('aria-label')!.split(' · ')[1])
    fireEvent.click(link)
    await screen.findByRole('heading', { level: 1, name: 'Архив' })
    await waitFor(() => expect(document.querySelectorAll('.archive .aitem')).toHaveLength(n))
    expect(n).toBe(4)
  })

  it('deleting an archived record asks first, then bins it with «Отменить»', async () => {
    const t = await spend('Сим-карта', { archived: true })
    await openArchive()
    const row = await rowOf('Сим-карта')
    fireEvent.click(within(row).getByRole('button', { name: 'Удалить' }))
    expect(row.textContent).toContain('Удалить эту запись навсегда?')
    fireEvent.click(within(row).getAllByRole('button', { name: 'Удалить' }).at(-1)!)
    await waitFor(() => expect(toastText()).toContain('Запись удалена'))
    expect((await env.db.transactions.get(t.id))!.deleted_at).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Отменить' }))
    await rowOf('Сим-карта')
    expect((await env.db.transactions.get(t.id))!.deleted_at).toBeNull()
  })

  it('goals: «$X из $Y» and «Вернуть»; categories: kind and records, delete moves them to «Прочее»', async () => {
    const goal = await env.repo.put<Goal>('goals', { name: 'Машина', target_usd: 100, deadline: null, archived: true })
    await env.repo.put<Category>('categories', { id: cat['Кафе и рестораны'].id, archived: true })
    const t = await spend('Пирожок')
    await openArchive()
    const g = await rowOf('Машина')
    expect(g.textContent).toContain('$0 из $100')
    fireEvent.click(within(g).getByRole('button', { name: 'Вернуть' }))
    await waitFor(() => expect(toastText()).toContain('Цель вернулась'))
    await waitFor(async () => expect((await env.db.goals.get(goal.id))!.archived).toBe(false))

    const c = await rowOf('Кафе')
    expect(c.textContent).toContain('Расход · 1 запись')
    fireEvent.click(within(c).getByRole('button', { name: 'Удалить' }))
    expect(c.textContent).toContain('Записи (1) перейдут в «Прочее». Удалить «Кафе и рестораны»?')
    fireEvent.click(within(c).getAllByRole('button', { name: 'Удалить' }).at(-1)!)
    await waitFor(() => expect(toastText()).toContain('Категория удалена, записи — в «Прочее»'))
    await waitFor(async () => expect((await env.db.transactions.get(t.id))!.category_id).toBe(cat['Прочее'].id))
  })

  it('opened from «Цели»: the back pill says «Цели»', async () => {
    renderWithApp(
      <Navigator
        renderScreen={(r: Route) =>
          r.screen === 'archive' ? <Archive /> : <GoalsLink />
        }
      />,
      env,
    )
    fireEvent.click(await screen.findByRole('button', { name: 'архив целей' }))
    expect(await screen.findByRole('button', { name: 'Назад, Цели' })).toBeTruthy()
  })
})

function GoalsLink() {
  const nav = useNav()
  return (
    <button type="button" onClick={() => nav.push({ tab: 'goals', screen: 'archive' })}>
      архив целей
    </button>
  )
}
