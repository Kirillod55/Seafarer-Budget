import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import { categoryStyle } from '@shared/defaults.ts'
import type { Category } from '@shared/types.ts'
import { useApp } from '../context.tsx'
import { isLightColor } from '../ui/CategoryIcon.tsx'
import { CATEGORY_GLYPHS, Tag } from '../ui/icons.ts'
import { Segmented } from '../ui/Segmented.tsx'
import { useToast } from '../ui/Toast.tsx'
import '../screens/record.css'
import '../screens/goals.css'
import '../screens/categories.css'

const FAILED = 'Не получилось — попробуй ещё раз'
export const NAME_MAX = 30

/** The 10 system colours (spec §4: a 5×2 grid; prototype CAT_COLORS) with their names for screen readers. */
export const CAT_COLORS: { value: string; name: string }[] = [
  { value: '#30B455', name: 'Зелёный' },
  { value: '#FF9500', name: 'Оранжевый' },
  { value: '#0A84FF', name: 'Синий' },
  { value: '#AF52DE', name: 'Фиолетовый' },
  { value: '#32ADE6', name: 'Голубой' },
  { value: '#FF3B30', name: 'Красный' },
  { value: '#FF2D55', name: 'Розовый' },
  { value: '#FFCC00', name: 'Жёлтый' },
  { value: '#A2845E', name: 'Коричневый' },
  { value: '#8E8E93', name: 'Серый' },
]

/** The 18 glyphs (spec §4: a 6×3 grid; prototype CAT_ICONS), their names and the emoji the bot shows. */
export const CAT_GLYPHS: { key: string; name: string; emoji: string }[] = [
  { key: 'cart', name: 'Корзина', emoji: '🛒' },
  { key: 'coffee', name: 'Кофе', emoji: '☕' },
  { key: 'car', name: 'Машина', emoji: '🚕' },
  { key: 'home', name: 'Дом', emoji: '🏠' },
  { key: 'wifi', name: 'Связь', emoji: '📶' },
  { key: 'health', name: 'Здоровье', emoji: '💊' },
  { key: 'ticket', name: 'Билет', emoji: '🎟️' },
  { key: 'doc', name: 'Документ', emoji: '📄' },
  { key: 'gift', name: 'Подарок', emoji: '🎁' },
  { key: 'plane', name: 'Самолёт', emoji: '✈️' },
  { key: 'shirt', name: 'Одежда', emoji: '👕' },
  { key: 'book', name: 'Книга', emoji: '📚' },
  { key: 'fuel', name: 'Топливо', emoji: '⛽' },
  { key: 'gym', name: 'Спорт', emoji: '🏋️' },
  { key: 'phone', name: 'Телефон', emoji: '📱' },
  { key: 'wallet', name: 'Кошелёк', emoji: '💰' },
  { key: 'box', name: 'Коробка', emoji: '📦' },
  { key: 'tag', name: 'Ярлык', emoji: '🏷️' },
]

const capitalize = (s: string) => (s ? s.charAt(0).toLocaleUpperCase('ru') + s.slice(1) : s)
const same = (a: string, b: string) => a.trim().toLocaleLowerCase('ru') === b.trim().toLocaleLowerCase('ru')

/**
 * Why the name cannot be used, or '' when it can: empty, or a repeat in any case of another category — live,
 * archived or in the 24 h bin (it may come back with «Отменить»). `self` is the category being edited.
 */
export function nameError(name: string, categories: Category[], self?: string): string {
  if (!name.trim()) return 'Впиши название'
  const twin = categories.find((c) => c.id !== self && !c.deleted && same(c.name, name))
  if (!twin) return ''
  return twin.archived ? 'Такая категория есть в архиве — верни её оттуда' : 'Такая категория уже есть'
}

type Kind = Category['kind']

/*
 * «Новая категория» / «Категория» (edit, from the swipe «Изменить»; spec §4, 2026-10-26) (spec §4 «Категории»; prototype catNewForm()): Расход / Доход, the name (≤ 30, saved with a
 * capital letter), a colour of 10 (5×2) and a glyph of 18 (6×3) drawn in that colour; «Создать» / «Отмена».
 * `categories` are all not deleted for good — archived and binned included (a repeat of any is refused; the sort
 * goes after all of them). The new category writes its `color` and `glyph`, and the matching emoji as `icon` for
 * the bot. Editing: name, colour and glyph prefilled, the kind is fixed, «Сохранить» writes only what changed.
 */
export function CategoryForm({
  categories,
  category,
  onClose,
}: {
  categories: Category[]
  /** the category to edit; unset = a new one */
  category?: Category
  onClose(): void
}) {
  const { repo } = useApp()
  const toast = useToast()
  const start = category ? categoryStyle(category) : { color: CAT_COLORS[2].value, glyph: 'tag' }
  const [kind, setKind] = useState<Kind>(category?.kind ?? 'expense')
  const [name, setName] = useState(category?.name ?? '')
  const [color, setColor] = useState(start.color)
  const [glyph, setGlyph] = useState(start.glyph)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const nameRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    nameRef.current?.focus({ preventScroll: true })
  }, [])

  async function save() {
    if (busy) return
    const clean = capitalize(name.trim().slice(0, NAME_MAX))
    const why = nameError(clean, categories, category?.id)
    setError(why)
    if (why) return
    const emoji = CAT_GLYPHS.find((g) => g.key === glyph)?.emoji ?? '🏷️'
    setBusy(true)
    try {
      if (category) {
        const patch: Partial<Category> = {}
        if (clean !== category.name) patch.name = clean
        if (color !== start.color) patch.color = color
        if (glyph !== start.glyph) Object.assign(patch, { glyph, icon: emoji })
        if (Object.keys(patch).length) await repo.put<Category>('categories', { id: category.id, ...patch })
        onClose()
        return
      }
      await repo.put<Category>('categories', {
        name: clean,
        kind,
        icon: emoji,
        keywords: [],
        archived: false,
        sort: categories.reduce((max, c) => Math.max(max, c.sort), -1) + 1,
        color,
        glyph,
        deleted_at: null,
        deleted_batch: null,
      })
      toast(`Категория «${clean}» добавлена`)
      onClose()
    } catch {
      setError(FAILED)
    } finally {
      setBusy(false)
    }
  }

  const enter = (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      void save()
    }
  }

  return (
    <section
      className="card gcard rec reveal catform"
      data-flip-key={category ? `edit-cat-${category.id}` : 'new-cat'}
      aria-labelledby="cn-title"
    >
      <h3 id="cn-title">{category ? 'Категория' : 'Новая категория'}</h3>
      {category ? (
        <p className="label cat-kind">{category.kind === 'income' ? 'Доход' : 'Расход'}</p>
      ) : (
        <Segmented<Kind>
          label="Тип"
          options={[
            { value: 'expense', label: 'Расход' },
            { value: 'income', label: 'Доход' },
          ]}
          value={kind}
          onChange={setKind}
        />
      )}
      <div className="fld">
        <label htmlFor="cn-name">Название</label>
        <input
          ref={nameRef}
          id="cn-name"
          className="inp"
          type="text"
          placeholder="Например, Спорт"
          autoComplete="off"
          maxLength={NAME_MAX}
          aria-invalid={!!error}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={enter}
        />
      </div>
      <div className="fld">
        <span className="flabel" id="cn-color">
          Цвет
        </span>
        <div className="swatches" role="group" aria-labelledby="cn-color">
          {CAT_COLORS.map((c) => (
            <button
              key={c.value}
              type="button"
              className="swatch"
              style={{ '--c': c.value } as CSSProperties}
              aria-pressed={color === c.value}
              aria-label={`Цвет: ${c.name}`}
              onClick={() => setColor(c.value)}
            />
          ))}
        </div>
      </div>
      <div className="fld">
        <span className="flabel" id="cn-glyph">
          Значок
        </span>
        <div className="icgrid" role="group" aria-labelledby="cn-glyph">
          {CAT_GLYPHS.map((g) => {
            const Glyph = CATEGORY_GLYPHS[g.key] ?? Tag
            return (
              <button
                key={g.key}
                type="button"
                aria-pressed={glyph === g.key}
                aria-label={`Значок: ${g.name}`}
                onClick={() => setGlyph(g.key)}
              >
                <span className={`ic${isLightColor(color) ? ' lt' : ''}`} style={{ '--c': color } as CSSProperties} aria-hidden="true">
                  <Glyph strokeWidth={2} />
                </span>
              </button>
            )
          })}
        </div>
      </div>
      {error && (
        <p className="gerr" role="alert">
          {error}
        </p>
      )}
      <div className="gacts">
        <button type="button" className="btn-acc" disabled={busy} onClick={() => void save()}>
          {category ? 'Сохранить' : 'Создать'}
        </button>
        <button type="button" className="btn-gray" disabled={busy} onClick={onClose}>
          Отмена
        </button>
      </div>
    </section>
  )
}
