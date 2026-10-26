import { describe, expect, it } from 'vitest'
import { asMessage, buttons, cat, cb, MemStore, msg, NOW, OWNER, PARTNER, run, SETTINGS, seedTx, textOf, TODAY } from './testkit.ts'
import type { Account } from '../types.ts'

const acc = (id: string, name: string, sort: number): Account => ({ id, deleted: false, name, aliases: [], is_default: sort === 0, archived: false, sort })
const multi = (s: MemStore) => {
  s.settingsRow = { ...SETTINGS, accounts_mode: 'multi', partner_name: 'Маша' }
  s.accountRows = [acc('acc1', 'Основной', 0), acc('acc2-cash-0000', 'Наличные', 1), acc('acc3-mono-0000', 'Монобанк', 2)]
}
/** Press «Сохранить» on a confirmation that answers the user's message `text`. */
const save = (s: MemStore, q: ReturnType<typeof asMessage>, text: string, chat = OWNER) =>
  run(s, cb('ok', { ...q, reply_to_message: { message_id: 5, text } }, chat))

describe('categories from the bot', () => {
  it('«создай категорию Спорт»: expense, gym, its own word; then «спорт 300» lands there', async () => {
    const s = new MemStore()
    const r = await run(s, msg('создай категорию Спорт'))
    const c = s.categoryRows.find((x) => x.name === 'Спорт')!
    expect(c).toMatchObject({ kind: 'expense', glyph: 'gym', keywords: ['спорт'], icon: '🏋️' })
    expect(textOf(r)).toBe('Создал категорию 🏋️ Спорт (расход)')
    await run(s, msg('спорт 300'))
    expect(s.txRows[0].category_id).toBe(c.id)
  })

  it('income kind, duplicate, archived, Masha notifies Kirill', async () => {
    const s = new MemStore()
    s.settingsRow = { ...SETTINGS, partner_name: 'Маша' }
    await run(s, msg('новая категория доходов Фриланс'))
    expect(s.categoryRows.find((x) => x.name === 'Фриланс')!.kind).toBe('income')
    expect(textOf(await run(s, msg('создай категорию продукты')))).toBe('Категория «Продукты» уже есть')
    s.categoryRows = s.categoryRows.map((c) => (c.name === 'Авто' ? { ...c, archived: true } : c))
    const a = await run(s, msg('создай категорию Авто'))
    expect(textOf(a)).toBe('Категория «Авто» в архиве')
    await run(s, cb(buttons(a)[0].callback_data))
    expect(s.categoryRows.find((c) => c.name === 'Авто')!.archived).toBe(false)
    const m = await run(s, msg('создай категорию Спорт', PARTNER))
    expect(m.find((x) => x.payload.chat_id === OWNER)?.payload.text).toBe('Маша создала категорию Спорт')
  })

  it('«… и впиши туда зал 500»: category + record; «Отменить все» removes both', async () => {
    const s = new MemStore()
    const r = await run(s, msg('создай категорию Спорт и впиши туда зал 500'))
    const c = s.categoryRows.find((x) => x.name === 'Спорт')!
    expect(s.txRows[0]).toMatchObject({ amount: 500, category_id: c.id })
    expect(textOf(r)).toContain('Создал категорию 🏋️ Спорт')
    await run(s, cb(buttons(r).at(-1)!.callback_data, asMessage(r[0])))
    expect(s.txRows[0].deleted).toBe(true)
    expect(s.categoryRows.find((x) => x.id === c.id)!.deleted).toBe(true)
  })

  it('«, впиши туда последнюю трату» and «перенеси туда все сигареты за этот месяц»', async () => {
    const s = new MemStore()
    s.txRows = [
      seedTx({ id: 'old', source: 'bot', note: 'сигареты', category_id: cat('Продукты').id, date: '2026-09-30' }),
      seedTx({ id: 's1', source: 'bot', note: 'сигареты', category_id: cat('Продукты').id, amount_usd: 2 }),
      seedTx({ id: 'last', source: 'bot', note: 'зал', created_at: '2026-10-20T00:00:00.000Z' }),
    ]
    await run(s, msg('создай категорию Спорт, впиши туда последнюю трату'))
    const sport = s.categoryRows.find((x) => x.name === 'Спорт')!
    expect(s.txRows.find((t) => t.id === 'last')!.category_id).toBe(sport.id)
    const r = await run(s, msg('создай категорию Сигареты и перенеси туда все сигареты за этот месяц'))
    const cig = s.categoryRows.find((x) => x.name === 'Сигареты')!
    expect(s.txRows.find((t) => t.id === 's1')!.category_id).toBe(cig.id)
    expect(s.txRows.find((t) => t.id === 'old')!.category_id).toBe(cat('Продукты').id)
    expect(textOf(r)).toContain('Перенёс: ')
    await run(s, cb(buttons(r)[0].callback_data))
    expect(s.txRows.find((t) => t.id === 's1')!.category_id).toBe(cat('Продукты').id)
  })

  it('deleting categories and goals is for the app', async () => {
    const s = new MemStore()
    expect(textOf(await run(s, msg('удали категорию Авто')))).toContain('в приложении')
  })
})

describe('money between accounts (group 1–2)', () => {
  it('transfer with «Отменить»; single mode explains', async () => {
    const s = new MemStore()
    expect(textOf(await run(s, msg('перевёл 200$ с основного на наличные')))).toContain('режиме «Несколько счетов»')
    multi(s)
    const r = await run(s, msg('перевёл 200$ с основного на наличные'))
    expect(s.txRows[0]).toMatchObject({ kind: 'transfer', amount: 200, currency: 'USD', account_id: 'acc1', to_account_id: 'acc2-cash-0000' })
    expect(textOf(r)).toBe('🔁 Основной → Наличные · $200')
    expect(buttons(r)[0].callback_data).toBe(`u:${s.txRows[0].id}`)
    await run(s, msg('снял в банкомате 1000 гривен'))
    expect(s.txRows[1]).toMatchObject({ amount: 1000, currency: 'UAH', account_id: 'acc1', to_account_id: 'acc2-cash-0000' })
    await run(s, msg('перевод 500 грн на моно'))
    expect(s.txRows[2]).toMatchObject({ to_account_id: 'acc3-mono-0000' })
  })

  it('exchange with the rate and NBU', async () => {
    const s = new MemStore()
    const r = await run(s, msg('поменял 100$ на 4100 грн'))
    expect(s.txRows[0]).toMatchObject({ kind: 'exchange', amount: 100, currency: 'USD', to_amount: 4100, to_currency: 'UAH' })
    expect(textOf(r)).toBe('💱 $100 → ₴4,100 · курс 41.00 (НБУ 41.20)')
    expect(textOf(await run(s, msg('обменял 4500 гривен на 100 долларов')))).toContain('курс 45.00')
  })

  it('reconciliation writes only after «Сохранить»; 0 difference says so', async () => {
    const s = new MemStore()
    s.txRows = [seedTx({ kind: 'income', amount: 3420, amount_usd: 3420 })]
    const q = await run(s, msg('на руках 3500$'))
    expect(textOf(q)).toBe('Должно быть $3,420, ты говоришь $3,500 — записать корректировку +$80?')
    expect(s.txRows).toHaveLength(1)
    const r = await save(s, asMessage(q[0]), 'на руках 3500$')
    expect(s.txRows[1]).toMatchObject({ kind: 'adjustment', amount: 80, currency: 'USD' })
    expect(textOf(r)).toContain('Записал корректировку +$80')
    expect(textOf(await run(s, msg('на руках 3500$')))).toContain('Всё сходится')
  })

  it('/balance, rate and conversion write nothing', async () => {
    const s = new MemStore()
    s.txRows = [seedTx({ kind: 'income', amount: 1000, amount_usd: 1000 }), seedTx({ kind: 'income', amount: 4120, currency: 'UAH', amount_usd: 100 })]
    const b = textOf(await run(s, msg('/balance')))
    expect(b).toContain('Всего ≈ $1,100')
    expect(b).toContain('Свободно: $1,100')
    expect(textOf(await run(s, msg('курс доллара')))).toContain('$1 = ₴41.20')
    expect(textOf(await run(s, msg('сколько 100 евро в гривнах')))).toBe('€100 = ₴4,490 (курс НБУ на 21 октября)')
    expect(s.txRows).toHaveLength(2)
  })
})

describe('reports and search (group 3)', () => {
  const seed = (s: MemStore) => {
    s.settingsRow = { ...SETTINGS, partner_name: 'Маша' }
    s.txRows = [
      seedTx({ amount: 10, amount_usd: 10, date: '2026-10-20', category_id: cat('Кафе и рестораны').id, note: 'кофе' }),
      seedTx({ amount: 5, amount_usd: 5, date: '2026-10-20', category_id: cat('Транспорт и такси').id, note: 'такси', author: 'partner' }),
      seedTx({ amount: 20, amount_usd: 20, date: '2026-09-10', category_id: cat('Кафе и рестораны').id, note: 'обед' }),
      seedTx({ amount: 420, currency: 'UAH', amount_usd: 10.19, date: '2026-10-21', category_id: cat('Продукты').id, note: 'атб' }),
    ]
  }
  it('days, week, named month, comparison', async () => {
    const s = new MemStore()
    seed(s)
    expect(textOf(await run(s, msg('сколько вчера')))).toContain('20 октября: $15 (Я $10 · Маша $5)')
    expect(textOf(await run(s, msg('/week')))).toContain('За неделю: $25.19')
    expect(textOf(await run(s, msg('итог за сентябрь')))).toContain('Итого за сентябрь: $20')
    expect(textOf(await run(s, msg('сравни с прошлым месяцем')))).toContain('Октябрь: $25.19 · Сентябрь: $20 · ↑ 26%')
  })

  it('category, word, people', async () => {
    const s = new MemStore()
    seed(s)
    expect(textOf(await run(s, msg('сколько на кафе в этом месяце')))).toContain('☕ Кафе и рестораны за октябрь: $10 · 1 запись')
    expect(textOf(await run(s, msg('сколько ушло на такси')))).toContain('«такси» за октябрь: $5')
    expect(textOf(await run(s, msg('сколько потратила маша')))).toContain('Маша за октябрь: $5')
    expect(textOf(await run(s, msg('кто сколько потратил')))).toContain('Я $20.19 · Маша $5')
  })

  it('search: numbered list, ✕ N bins with «Вернуть», /export sends a CSV', async () => {
    const s = new MemStore()
    seed(s)
    const r = await run(s, msg('найди такси'))
    expect(textOf(r)).toContain('Нашёл 1 запись')
    expect(buttons(r).map((b) => b.text)).toEqual(['✏️ 1', '✕ 1'])
    const d = await run(s, cb(buttons(r)[1].callback_data))
    expect(s.txRows[1].deleted_at).not.toBeNull()
    expect(buttons(d)[0].text).toBe('Вернуть')
    expect(textOf(await run(s, msg('найди 420')))).toContain('Продукты')
    expect(textOf(await run(s, msg('последние 10 записей')))).toContain('Нашёл 3 записи')
    const e = await run(s, msg('пришли выгрузку'))
    expect(e[0].method).toBe('sendDocument')
    expect((e[0].payload.document as { content: string }).content.split('\r\n').filter(Boolean)).toHaveLength(4) // header + 3 live
  })
})

describe('goals, limits, settings (groups 4, 5, 7)', () => {
  it('nothing changes before «Сохранить», «Отменить» after', async () => {
    const s = new MemStore()
    s.txRows = [seedTx({ kind: 'income', amount: 1200, amount_usd: 1200, date: '2026-10-01' })]
    const q = await run(s, msg('посадка 31 октября'))
    expect(textOf(q)).toBe('Посадка 31 октября 2026: было без даты → станет $109.09 в день')
    expect(s.settingsRow!.next_contract_date).toBeNull()
    const r = await save(s, asMessage(q[0]), 'посадка 31 октября')
    expect(s.settingsRow!.next_contract_date).toBe('2026-10-31')
    await run(s, cb(buttons(r)[0].callback_data))
    expect(s.settingsRow!.next_contract_date).toBeNull()
  })

  it.each([
    ['запас 1000$', (s: MemStore) => s.settingsRow!.reserve_usd === 1000],
    ['по умолчанию леи', (s: MemStore) => s.settingsRow!.default_currency === 'MDL'],
    ['добавь валюту PLN', (s: MemStore) => s.settingsRow!.currencies.includes('PLN')],
    ['напоминай через 3 дня', (s: MemStore) => s.settingsRow!.remind_after_days === 3],
    ['новая цель отпуск 2000$ к июню', (s: MemStore) => s.goalRows.some((g) => g.name === 'Отпуск' && g.target_usd === 2000 && g.deadline === '2027-06-30')],
    ['лимит на кафе 150$', (s: MemStore) => s.limitRows.some((l) => l.category_id === cat('Кафе и рестораны').id && l.monthly_usd === 150)],
  ])('%s: saved only after the button', async (text, check) => {
    const s = new MemStore()
    const q = await run(s, msg(text))
    expect(check(s)).toBe(false)
    await save(s, asMessage(q[0]), text)
    expect(check(s)).toBe(true)
  })

  it('«создай счёт Монобанк»; deleting an empty account asks «Да · Нет», «Нет» keeps it, «Да» deletes for good without undo', async () => {
    const s = new MemStore()
    multi(s)
    s.accountRows = s.accountRows.slice(0, 2)
    const q = await run(s, msg('создай счёт Монобанк'))
    await save(s, asMessage(q[0]), 'создай счёт Монобанк')
    const mono = s.accountRows.find((a) => a.name === 'Монобанк')!
    expect(mono).toBeTruthy()
    const d = await run(s, msg('удали счёт Монобанк'))
    expect(textOf(d)).toBe('Удалить счёт «Монобанк»? Старые записи сохранятся, счёт пропадёт из списков. Вернуть нельзя.')
    expect(buttons(d).map((b) => b.text)).toEqual(['Да', 'Нет'])
    await run(s, cb('no'))
    expect(s.accountRows.find((a) => a.id === mono.id)!.deleted).toBe(false)
    const yes = await run(s, cb(buttons(d)[0].callback_data))
    expect(s.accountRows.find((a) => a.id === mono.id)!.deleted).toBe(true)
    expect(textOf(yes)).toContain('Удалил счёт «Монобанк»')
    expect(buttons(yes)).toEqual([])
  })

  it('the main account and an account with money are not deleted — the bot explains', async () => {
    const s = new MemStore()
    multi(s)
    expect(textOf(await run(s, msg('удали счёт основной')))).toContain('Основной счёт удалить нельзя')
    s.txRows = [seedTx({ kind: 'income', amount: 1200, currency: 'UAH', amount_usd: 29.13, account_id: 'acc3-mono-0000' })]
    const d = await run(s, msg('закрой счёт монобанк'))
    expect(textOf(d)).toContain('На счёте «Монобанк» ₴1,200 (≈ $29) — удалить можно только пустой счёт')
    expect(buttons(d)).toEqual([])
    // a stale «Да» from before the money arrived is checked again
    const yes = await run(s, cb('acd:acc3-mon'))
    expect(textOf(yes)).toContain('удалить можно только пустой счёт')
    expect(s.accountRows.find((a) => a.id === 'acc3-mono-0000')!.deleted).toBe(false)
    expect(textOf(await run(s, msg('убери счёт монобанк в архив')))).toContain('Архив счетов — в приложении')
  })

  it('daily summary: only the writer’s own flag, at once', async () => {
    const s = new MemStore()
    expect(textOf(await run(s, msg('присылай итог дня', PARTNER)))).toBe('🔔 Итог дня включён — пришлю вечером')
    expect(s.settingsRow).toMatchObject({ daily_summary_partner: true, daily_summary_owner: false })
    await run(s, msg('выключи итог дня', PARTNER))
    expect(s.settingsRow!.daily_summary_partner).toBe(false)
  })

  it('/settings buttons change at once and redraw', async () => {
    const s = new MemStore()
    const m = await run(s, msg('/settings'))
    expect(buttons(m).map((b) => b.callback_data)).toContain('st:r:3')
    const r = await run(s, cb('st:r:3', asMessage(m[0])))
    expect(s.settingsRow!.remind_after_days).toBe(3)
    expect(textOf(r)).toContain('Напоминание без записей: 3 дн.')
    await run(s, cb('st:s'))
    expect(s.settingsRow!.daily_summary_owner).toBe(true)
    await run(s, cb('st:c:EUR'))
    expect(s.settingsRow!.default_currency).toBe('EUR')
  })

  it('/goals and /limits', async () => {
    const s = new MemStore()
    s.goalRows = [{ id: 'g1', deleted: false, deleted_at: null, deleted_batch: null, name: 'Машина', target_usd: 1000, deadline: null, archived: false }]
    s.moveRows = [{ id: 'm', deleted: false, goal_id: 'g1', amount_usd: 250, date: TODAY, note: '', author: 'owner', source: 'app', created_at: NOW.toISOString() }]
    expect(textOf(await run(s, msg('/goals')))).toContain('🎯 Машина: $250 из $1,000 (25%)')
    s.limitRows = [{ id: 'l', deleted: false, deleted_at: null, deleted_batch: null, category_id: cat('Кафе и рестораны').id, monthly_usd: 100 }]
    s.txRows = [seedTx({ category_id: cat('Кафе и рестораны').id, amount: 85, amount_usd: 85 })]
    expect(textOf(await run(s, msg('как лимиты')))).toContain('☕ Кафе и рестораны: $85 из $100 · ⚠️ почти всё')
  })
})

describe('/help and commands in words', () => {
  it('help: HTML, < 4096, lines by mode and chat', async () => {
    const s = new MemStore()
    const h = await run(s, msg('/help'))
    expect(h[0].payload.parse_mode).toBe('HTML')
    const owner = textOf(h)
    expect(owner.length).toBeLessThan(4096)
    expect(owner).toContain('По воскресеньям присылаю резервную копию')
    expect(owner).not.toContain('кофе 80 прокредит')
    expect(owner).toContain('Напоминаю, если 2 дня нет записей')
    s.settingsRow = { ...SETTINGS, accounts_mode: 'multi', partner_name: 'Маша', remind_after_days: 0 }
    const her = textOf(await run(s, msg('/start', PARTNER)))
    expect(her.startsWith('Привет, Маша!')).toBe(true)
    expect(her).toContain('Твои траты сразу видит Кирилл')
    expect(her).toContain('кофе 80 прокредит')
    expect(her).not.toContain('Напоминаю')
    expect(her).not.toContain('резервную копию')
    expect(textOf(await run(s, msg('что ты умеешь?')))).toContain('Как пользоваться ботом')
  })

  it('phrases: «Ээ, сделай проверку», «сколько осталось», «отмени»; «кофе 80» is still a record', async () => {
    const s = new MemStore()
    expect(textOf(await run(s, msg('Ээ, сделай проверку')))).toContain('На связи')
    expect(textOf(await run(s, msg('ты тут?')))).toContain('На связи')
    expect(textOf(await run(s, msg('сколько осталось')))).toContain('Укажи дату посадки')
    expect(textOf(await run(s, msg('отмени')))).toContain('Нечего отменять')
    await run(s, msg('кофе 80'))
    expect(s.txRows).toHaveLength(1)
  })
})

describe('/clear and «удали <описание>» (spec §4, §5)', () => {
  const seed = (s: MemStore) => {
    s.txRows = [
      seedTx({ id: 'a', amount: 10, amount_usd: 10, date: TODAY, category_id: cat('Кафе и рестораны').id, note: 'кофе', rev: 3 }),
      seedTx({ id: 'b', amount: 80, currency: 'UAH', amount_usd: 1.94, date: '2026-10-20', category_id: cat('Кафе и рестораны').id, note: 'кофе', rev: 4 }),
      seedTx({ id: 'c', kind: 'income', amount: 500, amount_usd: 500, date: '2026-10-18', rev: 5 }),
      seedTx({ id: 'd', amount: 7, amount_usd: 7, date: '2026-09-01', author: 'partner', note: 'кофе', rev: 6 }),
    ]
  }

  it('period → kind → summary with CSV → delete → «Вернуть»', async () => {
    const s = new MemStore()
    seed(s)
    const p = await run(s, msg('/clear'))
    expect(buttons(p).map((b) => b.text)).toEqual(['Сутки', 'Неделя', 'Месяц', 'Всё время', 'Отмена'])
    const k = await run(s, cb(buttons(p)[1].callback_data))
    const sum = await run(s, cb(buttons(k).find((b) => b.text === 'Только траты')!.callback_data))
    expect(sum.find((x) => x.method === 'sendDocument')).toBeTruthy()
    expect(textOf(sum)).toContain('Удалю 2 записи за 15–21 октября: траты $11.94. Копию прислал файлом.')
    const del = await run(s, cb(buttons(sum).find((b) => b.text.startsWith('Удалить'))!.callback_data))
    expect(textOf(del)).toContain('Удалено 2 записи. Вернуть можно 24 часа')
    expect(s.txRows.filter((t) => t.deleted_at).map((t) => t.id)).toEqual(['a', 'b'])
    await run(s, cb(buttons(del)[0].callback_data))
    expect(s.txRows.every((t) => t.deleted_at === null)).toBe(true)
  })

  it('words skip the steps; buttons expire after 10 minutes; Masha cannot clear', async () => {
    const s = new MemStore()
    seed(s)
    expect(textOf(await run(s, msg('удали всё за сегодня')))).toContain('Удалю 1 запись за сегодня')
    const p = await run(s, msg('удали траты за неделю'))
    const late = new Date(NOW.getTime() + 11 * 60_000)
    expect(textOf(await run(s, cb(buttons(p)[0].callback_data), late))).toContain('Время вышло, начни заново: /clear')
    expect(textOf(await run(s, msg('/clear', PARTNER)))).toBe('Удалять историю может только Кирилл')
    expect(textOf(await run(s, msg('очисти историю')))).toContain('За какой период')
  })

  it('«удали кофе 80 за вчера»: one match → confirm → delete with «Вернуть»; /undo also returns it', async () => {
    const s = new MemStore()
    seed(s)
    const q = await run(s, msg('удали кофе 80 за вчера'))
    expect(textOf(q)).toBe('Удалить? Кафе и рестораны · кофе · ₴80 ($1.94) · 20 октября')
    const d = await run(s, cb(buttons(q)[0].callback_data))
    expect(textOf(d)).toContain('Удалил: Кафе и рестораны · кофе · ₴80')
    expect(s.txRows.find((t) => t.id === 'b')!.deleted_at).not.toBeNull()
    await run(s, msg('/undo'))
    expect(s.txRows.find((t) => t.id === 'b')!.deleted_at).toBeNull()
  })

  it('several matches → buttons; «последнюю»; none; Masha hears Kirill’s are his', async () => {
    const s = new MemStore()
    seed(s)
    const many = await run(s, msg('удали кофе'))
    expect(textOf(many)).toContain('Нашёл 2 записи, какую удалить?')
    expect(textOf(await run(s, msg('удали последнюю трату на кофе')))).toContain('21 октября')
    expect(textOf(await run(s, msg('удали атб 999')))).toBe('Не нашёл такую запись. Последние записи: /last')
    expect(textOf(await run(s, msg('удали кофе', PARTNER)))).toBe('Это запись Кирилла — удалить её может только он')
    expect(textOf(await run(s, msg('удали кафе 10')))).toContain('Удалить? Кафе и рестораны · кофе · $10')
  })
})