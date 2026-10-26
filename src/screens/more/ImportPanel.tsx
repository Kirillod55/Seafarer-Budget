import { useId, useRef, useState } from 'react'
import { alive } from '@shared/alive.ts'
import { parseCsv, planImport, resolveAccount, type ImportError, type ImportRow } from '@shared/csv.ts'
import { money } from '@shared/format.ts'
import { useApp } from '../../context.tsx'
import { Morph } from '../../ui/Morph.tsx'
import { Segmented } from '../../ui/Segmented.tsx'
import { useToast } from '../../ui/Toast.tsx'
import { dayMonth, plural } from '../../ui/dates.ts'
import { FAILED } from './common.tsx'

/** how many rows of the file the preview shows */
const PREVIEW_ROWS = 5
/** line numbers listed per error before «…» */
const LINES_SHOWN = 12

const KIND_LABEL: Record<ImportRow['kind'], string> = {
  expense: 'Расход',
  income: 'Доход',
  transfer: 'Перевод',
  exchange: 'Обмен',
  adjustment: 'Корректировка',
}

interface Preview {
  /** a new one per file: the Morph key */
  id: number
  fresh: ImportRow[]
  duplicates: number
  unknownCategories: string[]
  unknownAccounts: string[]
  /** the default account's name: where rows with an unknown «Счёт» go */
  defaultAccount: string
  /** one line per reason: «Строки 3, 4: …» */
  errors: string[]
}

const records = (n: number) => plural(n, 'запись', 'записи', 'записей')

/** «Строка 2: Неизвестный тип», «Строки 3, 4: …» — rows with the same reason together, in file order. */
function errorLines(errors: ImportError[]): string[] {
  const byReason = new Map<string, number[]>()
  for (const e of [...errors].sort((a, b) => a.line - b.line)) byReason.set(e.reason, [...(byReason.get(e.reason) ?? []), e.line])
  return [...byReason].map(([reason, lines]) => {
    const shown = lines.slice(0, LINES_SHOWN).join(', ') + (lines.length > LINES_SHOWN ? ', …' : '')
    return `${lines.length === 1 ? 'Строка' : 'Строки'} ${shown}: ${reason}`
  })
}

function readText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsText(file, 'utf-8')
  })
}

/*
 * «Загрузить из CSV» inside «Резервная копия» (spec §4 «Загрузить из CSV», §6 «Плавная перерисовка»): pick a file →
 * parseCsv + planImport → «Найдено 54 записи: 50 новых, 4 уже есть — их пропущу», the first rows, the categories and
 * accounts that do not exist (categories: create them or put the rows into «Прочее»; accounts: onto the default one),
 * the rows with errors by number → «Загрузить 50 записей» → repo.importRows → toast «Загружено 50 записей ·
 * Отменить» (repo.markBatchDeleted). The preview swaps in place (Morph): the rest of the screen does not move.
 */
export function ImportPanel({ partnerName }: { partnerName: string | null }) {
  const { db, repo } = useApp()
  const toast = useToast()
  const inputId = useId()
  const fileRef = useRef<HTMLInputElement>(null)
  const ids = useRef(0)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [create, setCreate] = useState(true)
  const [busy, setBusy] = useState(false)

  async function choose(file: File | undefined) {
    if (!file || busy) return
    setBusy(true)
    try {
      const text = await readText(file)
      const parsed = parseCsv(text, partnerName)
      const [txs, categories, accounts] = await Promise.all([
        db.transactions.toArray(),
        db.categories.toArray(),
        db.accounts.toArray(),
      ])
      const plan = planImport(parsed.rows, txs, categories, accounts)
      setCreate(true)
      setPreview({
        id: ++ids.current,
        fresh: plan.fresh,
        duplicates: plan.duplicates.length,
        unknownCategories: plan.unknownCategories,
        unknownAccounts: plan.unknownAccounts,
        defaultAccount: resolveAccount(accounts.filter(alive), '')?.name ?? 'Основной',
        errors: errorLines([...parsed.errors, ...plan.errors]),
      })
    } catch {
      toast(FAILED)
    } finally {
      setBusy(false)
      // the same file can be picked again
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  async function load() {
    if (!preview || busy || !preview.fresh.length) return
    setBusy(true)
    try {
      const { batch, count } = await repo.importRows(preview.fresh, { createCategories: create })
      setPreview(null)
      toast(`Загружено ${records(count)}`, { label: 'Отменить', run: () => repo.markBatchDeleted(batch) })
    } catch {
      toast(FAILED)
    } finally {
      setBusy(false)
    }
  }

  const p = preview
  const found = p ? p.fresh.length + p.duplicates : 0

  return (
    <>
      <input
        ref={fileRef}
        id={inputId}
        className="ifile"
        type="file"
        accept=".csv,text/csv,text/plain"
        aria-label="Файл CSV"
        tabIndex={-1}
        onChange={(e) => void choose(e.target.files?.[0])}
      />
      <Morph k={p ? `p${p.id}` : 'idle'} className="wbox">
        {!p ? (
          <button type="button" className="btn-gray" disabled={busy} onClick={() => fileRef.current?.click()}>
            Загрузить из CSV
          </button>
        ) : (
          <div className="imp" role="group" aria-label="Загрузка из CSV">
            <p className="isum">
              {found
                ? `Найдено ${records(found)}: ${plural(p.fresh.length, 'новая', 'новые', 'новых')}` +
                  (p.duplicates ? `, ${p.duplicates} уже есть — их пропущу` : '')
                : 'В файле нет записей, которые можно загрузить'}
            </p>
            {p.fresh.length > 0 && (
              <ul className="iprev" aria-label="Первые записи">
                {p.fresh.slice(0, PREVIEW_ROWS).map((r) => (
                  <li key={r.line}>
                    <span className="it">
                      {[dayMonth(r.date), r.category.trim() || KIND_LABEL[r.kind], r.note].filter(Boolean).join(' · ')}
                    </span>
                    <span className={`ia num${r.kind === 'income' ? ' inc' : ''}`}>
                      {(r.kind === 'income' ? '+' : '') + money(r.amount, r.currency)}
                    </span>
                  </li>
                ))}
                {p.fresh.length > PREVIEW_ROWS && <li className="label">{`и ещё ${p.fresh.length - PREVIEW_ROWS}`}</li>}
              </ul>
            )}
            {p.unknownCategories.length > 0 && (
              <>
                <p className="label iunknown">{`Таких категорий нет: ${p.unknownCategories.join(', ')}`}</p>
                <Segmented<'create' | 'other'>
                  label="Новые категории"
                  options={[
                    { value: 'create', label: 'Создать' },
                    { value: 'other', label: 'В «Прочее»' },
                  ]}
                  value={create ? 'create' : 'other'}
                  onChange={(v) => setCreate(v === 'create')}
                />
              </>
            )}
            {p.unknownAccounts.length > 0 && (
              <p className="label iunknown">
                {p.unknownAccounts.length === 1
                  ? `Счёта «${p.unknownAccounts[0]}» нет — его записи лягут на «${p.defaultAccount}»`
                  : `Счетов ${p.unknownAccounts.map((a) => `«${a}»`).join(', ')} нет — их записи лягут на «${p.defaultAccount}»`}
              </p>
            )}
            {p.errors.length > 0 && (
              <ul className="ierrs" aria-label="Строки с ошибками — их пропущу">
                {p.errors.map((e) => (
                  <li key={e} className="label err ierr">
                    {e}
                  </li>
                ))}
              </ul>
            )}
            <div className="wact">
              <button type="button" className="btn-gray" onClick={() => setPreview(null)}>
                Отмена
              </button>
              <button type="button" className="iload" disabled={busy || !p.fresh.length} onClick={() => void load()}>
                {p.fresh.length ? `Загрузить ${records(p.fresh.length)}` : 'Загружать нечего'}
              </button>
            </div>
          </div>
        )}
      </Morph>
    </>
  )
}
