// Manual layout check of the phone UI (stage 2, Task 15). No test-runner dependency: the checker runs inside the
// demo app itself.
//
//   1. npx vite                       (or reuse a running dev server)
//   2. open http://localhost:5173/#demo in a browser at 375 px width (DevTools device mode, or the Claude browser pane)
//   3. in the page console:   const c = await import('/scripts/check-layout.mjs'); console.table((await c.run()).rows)
//
// `node scripts/check-layout.mjs` only prints these steps. run() walks every screen and state below in the dark and
// the light theme, each at text scale 1 and 1.2 (Dynamic Type), and for every state measures:
//   - overflow: <html> wider than the viewport (scrollWidth > clientWidth), or a visible element whose box —
//     clipped by its overflow-hidden ancestors — sticks out past the left or right edge;
//   - backgrounds: an opaque background that is light in the dark theme (relative luminance > 0.45) or dark in the
//     light theme (< 0.12), except the tokens that are meant to be so (lime, the partner chip, swipe actions …).
// It changes the demo data only through the UI and puts back what it changed (the landing date, an archived record);
// a record deleted for the «Вернуть удалённое» state is restored at the end.

if (typeof window === 'undefined') {
  console.log(
    [
      'Layout check: open http://localhost:5173/#demo at 375 px width, then in the page console:',
      "  const c = await import('/scripts/check-layout.mjs'); console.table((await c.run()).rows)",
    ].join('\n'),
  )
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
/**
 * Jumps the running transitions (screen push, sheet, reveal) to their end: the layout is measured in its resting
 * state, also when the page runs in a background tab whose animation timeline does not advance.
 */
const settled = async () => {
  for (const a of document.getAnimations()) {
    if (a.effect?.getTiming().iterations === Infinity) continue
    try {
      a.finish()
    } catch {
      /* an animation without an end */
    }
  }
  await wait(50)
}
const $ = (sel, root = document) => root.querySelector(sel)
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)]
/** The visible screen: lower stack entries stay mounted but are inert. */
const top = () => $('.app > .screen:not(.below)') ?? document.body

function button(name, root = document) {
  const label = (b) => (b.getAttribute('aria-label') || b.textContent || '').trim()
  return $$('button', root).find((b) => !b.closest('[inert]') && (typeof name === 'string' ? label(b) === name : name.test(label(b))))
}
async function click(name, root) {
  const b = typeof name === 'string' || name instanceof RegExp ? button(name, root) : name
  if (!b) throw new Error(`no button ${name}`)
  b.click()
  await wait(300)
  await settled()
  await wait(150)
}
async function tab(name) {
  await click($$('.tabs .tab').find((t) => t.textContent.trim() === name))
  // a second tap on the current tab pops its stack to the root
  if ($('.app > .screen:not(.below) .navback')) await click($$('.tabs .tab').find((t) => t.textContent.trim() === name))
}
async function back() {
  const b = $('.app > .screen:not(.below) .navback')
  if (b) await click(b)
}
/** Sets a React-controlled input's value the way typing does. */
function type(input, value) {
  const proto = Object.getPrototypeOf(input)
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

// ---------- measurements ----------

function rgba(css) {
  const m = css.match(/rgba?\(([^)]+)\)/)
  if (!m) return null
  const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number)
  return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }
}
function luminance({ r, g, b }) {
  const f = (c) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}
/** Token colours that may be light in the dark theme / dark in the light theme by design. */
function allowedColours() {
  const probe = document.createElement('i')
  document.body.append(probe)
  const out = new Set()
  for (const t of ['--accent', '--partner', '--act-edit', '--act-del', '--act-arch', '--pill-warn', '--text', '--warn', '--danger', '--ok', '--anchor', '--on-accent']) {
    probe.style.backgroundColor = `var(${t})`
    out.add(getComputedStyle(probe).backgroundColor)
  }
  probe.remove()
  return out
}
function describe(el) {
  const cls = typeof el.className === 'string' && el.className ? `.${el.className.trim().split(/\s+/).join('.')}` : ''
  const txt = (el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 24)
  return `${el.tagName.toLowerCase()}${cls}${txt ? ` «${txt}»` : ''}`
}
function visible(el) {
  if (el.closest('[inert], [hidden]')) return false
  const cs = getComputedStyle(el)
  return cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0.05
}
/** The element's box cut by every ancestor that clips its overflow. */
function clippedRect(el) {
  const r = el.getBoundingClientRect()
  let left = r.left
  let right = r.right
  for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) {
    const cs = getComputedStyle(p)
    if (/hidden|clip|auto|scroll/.test(cs.overflowX)) {
      const pr = p.getBoundingClientRect()
      left = Math.max(left, pr.left)
      right = Math.min(right, pr.right)
    }
  }
  return { left, right, width: right - left }
}

export function measure(label) {
  const vw = document.documentElement.clientWidth
  const dark = (document.documentElement.dataset.theme ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')) === 'dark'
  const allowed = allowedColours()
  const overflow = []
  const backgrounds = []
  if (document.documentElement.scrollWidth > vw) overflow.push(`html scrollWidth ${document.documentElement.scrollWidth} > ${vw}`)
  for (const el of $$('body *')) {
    if (el.closest('svg') && el.tagName.toLowerCase() !== 'svg') continue
    if (!visible(el)) continue
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) continue
    const c = clippedRect(el)
    if (c.width > 0.5 && (c.right > vw + 0.5 || c.left < -0.5)) overflow.push(`${describe(el)} [${Math.round(c.left)}…${Math.round(c.right)}]`)
    const bg = rgba(getComputedStyle(el).backgroundColor)
    if (!bg || bg.a < 0.5) continue
    const L = luminance(bg)
    const wrong = dark ? L > 0.45 : L < 0.12
    if (wrong && !allowed.has(getComputedStyle(el).backgroundColor)) backgrounds.push(`${describe(el)} ${getComputedStyle(el).backgroundColor}`)
  }
  return { label, overflow, backgrounds }
}

// ---------- the walk ----------

async function states(add) {
  await tab('Главная')
  await add('Главная')
  await click('Новая запись')
  await add('Шторка: новая запись')
  const pick = $$('.sheet button').find((b) => b.getAttribute('aria-haspopup') === 'listbox' || b.className.includes('picker'))
  if (pick) {
    await click(pick)
    await add('Шторка + меню выбора')
    document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await wait(300)
  }
  await click('Отмена', $('.sheet'))
  await wait(400)

  // a row swiped open (the keyboard path of SwipeRow: ArrowLeft on a focused row)
  const row = $('.app > .screen:not(.below) .swipe > .tx')
  row.focus()
  row.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
  await wait(500)
  await add('Главная: смахнутая строка')
  await click('В архив', row.parentElement)
  await wait(500)
  await add('Тост «Запись в архиве»')
  await click('Отменить')
  await wait(500)

  await tab('Главная')
  await click($('.datebtn'))
  await add('Календарь')
  await back()

  await tab('Отчёт')
  await add('Отчёт')
  const tile = $$('.rtile').find((t) => t.tagName === 'BUTTON')
  if (tile) {
    await click(tile)
    await add('Расходы')
    await back()
  }

  await tab('Цели')
  await add('Цели')
  await click('Добавить')
  await add('Цели: новая цель')
  await click('Отмена', top())

  await tab('Ещё')
  await add('Ещё')
  for (const [name, title] of [
    ['Лимиты', 'Лимиты'],
    ['Счета', 'Счета'],
    ['Категории', 'Категории'],
    [/^Архив/, 'Архив'],
  ]) {
    await click(name, top())
    await add(title)
    await back()
  }
}

/** Landing-date states: «без даты» and «в рейсе» on the home screen; the date is put back afterwards. */
async function dateStates(add) {
  await tab('Ещё')
  const field = $('#m-board') ?? $$('input[type="date"]', top())[0]
  const was = field.value
  type(field, '')
  field.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
  field.blur()
  await wait(500)
  await tab('Главная')
  await add('Главная: без даты')
  await tab('Ещё')
  const d = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
  type($('#m-board') ?? $$('input[type="date"]', top())[0], d)
  await wait(500)
  await tab('Главная')
  await add('Главная: в рейсе')
  await tab('Ещё')
  type($('#m-board') ?? $$('input[type="date"]', top())[0], was)
  await wait(500)
}

/** «Вернуть удалённое» (the 24 h bin) in «Ещё», after deleting a record; restored with «Отменить». */
async function binState(add) {
  await tab('Главная')
  const row = $('.app > .screen:not(.below) .swipe > .tx')
  row.focus()
  row.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
  await wait(500)
  await click('Удалить', row.parentElement)
  await wait(600)
  await tab('Ещё')
  await add('Ещё: корзина «Вернуть удалённое»')
  const undo = button('Отменить')
  if (undo) await click(undo)
}

export async function run({ themes = ['dark', 'light'], scales = [1, 1.2] } = {}) {
  const html = document.documentElement
  const rows = []
  const failures = []
  const savedTheme = html.getAttribute('data-theme')
  try {
    for (const theme of themes) {
      for (const ts of scales) {
        html.setAttribute('data-theme', theme)
        html.style.setProperty('--ts', String(ts))
        await wait(500)
        const add = async (label) => {
          await wait(250)
          await settled()
          await wait(100)
          const m = measure(`${label} · ${theme} · ${ts}`)
          rows.push({ state: m.label, overflow: m.overflow.length, backgrounds: m.backgrounds.length })
          if (m.overflow.length || m.backgrounds.length) failures.push(m)
        }
        await states(add)
        await dateStates(add)
        await binState(add)
      }
    }
  } finally {
    if (savedTheme) html.setAttribute('data-theme', savedTheme)
    else html.removeAttribute('data-theme')
    html.style.setProperty('--ts', '1')
  }
  return { rows, failures, ok: failures.length === 0 }
}
