# Seafarer Budget 1.1 — этапы 0–1: подготовка и данные — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** быстрые и надёжные тесты, проверенная синхронизация и iPhone-оболочка, затем весь слой данных 1.1: миграция, типы, расчёт дневного бюджета, формат сумм, удаление с возвратом, архив трат, автор записи, CSV с «Кто» и импорт — чтобы этапы 2–6 строили интерфейс и бота на готовых функциях.

**Architecture:** чистая логика живёт в `supabase/functions/_shared/` (её используют и приложение, и бот на Deno — без npm-импортов). Приложение пишет в Dexie через `src/db/repo.ts`, синхронизирует через `src/db/sync.ts` (rev-модель 1.0). Сервер — Postgres в Supabase; правила целостности (удаление побеждает устаревшую правку) — в триггере `set_rev`. SQL проверяется в тестах на PGlite (Postgres в WASM), без Docker и без живой базы.

**Tech Stack:** TypeScript 7, React 19, Vite 8, Vitest 5 (jsdom), Dexie 4 + fake-indexeddb, Supabase (Postgres, PostgREST), `@electric-sql/pglite` (новая dev-зависимость, только для тестов SQL).

**Spec:** `docs/superpowers/specs/2026-10-22-redesign-daily-budget-design.md` — разделы 2, 4 (архив трат, удаление данных, импорт), 6 «Формат сумм», 7, 8, 9 «Данные», 10 (поля настроек), 12 этап 0–1. Дорожная карта: `docs/superpowers/plans/2026-10-25-v11-roadmap.md`.

## Global Constraints

- Ветка `v1.1` от `main`; ничего не пушить и не деплоить; живой бот 1.0 не трогать.
- Секреты только из `.env` / `bot.env`, значения не печатать.
- Код в `supabase/functions/_shared/` — без npm-импортов (его исполняет Deno), импорты с расширением `.ts`.
- Удалённая строка = `deleted === true` **или** `deleted_at !== null`; везде проверять через `alive()` (Задача 5).
- `deleted = true` — окончательное удаление (после 24 ч или «Удалить навсегда»); сервер никогда не снимает `deleted` обратно.
- Формат сумм (§6): знак впереди, тысячи запятой, копейки точкой: `$4,963.32`, `₴1,200`, `€12.50`; валюты без своего знака — кодом: `MDL 90`. Знаки: USD `$`, UAH `₴`, EUR `€`, PLN `zł`, GBP `£`, TRY `₺`, GEL `₾`; MDL и прочие — код.
- `дней = daysBetween(сегодня, дата_посадки) + 1`; `бюджет_на_день = max(0, свободно_утром) / дней` (§2).
- Периоды удаления (§4): «Сутки» = сегодня; «Неделя» = последние 7 дней с сегодня; «Месяц» = последние 30 дней; «Всё время»; границы включительно; будущие даты не трогаются.
- Возврат удалённого — 24 часа с `deleted_at`.
- CSV: UTF-8 с BOM, разделитель «;», дробная часть запятой; колонки выгрузки 1.1: `Дата;Тип;Сумма;Валюта;Сумма USD;Категория;Счёт;Заметка;Кто;Счёт куда;Сумма куда;Валюта куда` («Кто» — «Я» или имя второго человека, по умолчанию «Она»; последние три — вторая часть перевода/обмена). Выгрузка — полная резервная копия: импорт принимает «;» или «,», колонки по названию и все типы (расход, доход, корректировка, перевод, обмен). (Уточнено 2026-10-25 по итоговому ревью этапа 0–1.)
- Имя второго человека при выпуске — «Маша» (миграция не задаёт его — это шаг выпуска, этап 7).

## Review Focus

1. **Устаревшая правка после удаления на другом устройстве** — запись удалили на ПК, а телефон без сети поправил её и отправил позже: запись должна остаться удалённой (правка не «воскрешает»). Тесты: Задача 4 (SQL) и Задача 9 (синхронизация).
2. **Старое приложение 1.0 после миграции** — Windows-программа 1.0 и iPhone с кэшем 1.0 продолжают синхронизировать без новых полей: их вставки получают значения по умолчанию, их обновления не стирают `author`/`archived`/`deleted_at`. Тест: Задача 4.
3. **Удаление и импорт на границе дня и часового пояса** — «Сутки» в 00:30 по Киеву берут записи этой даты по Киеву, а не по UTC. Тесты: Задача 6 (`localDate` в 00:30) и Задача 9 (`selectForWipe` получает этот `today`).
4. **Повторный импорт того же файла** — второй раз ничего не добавляет (все строки «уже есть»), включая строки с «Кто» = имя второго человека и суммы с запятой. Тест: Задача 8.
5. **Возврат после частичной ручной правки** — после очистки одну из удалённых записей окончательно удалили, затем «Вернуть»: возвращаются остальные, окончательно удалённая не воскресает. Тест: Задача 9.

---

## Этап 0 — подготовка

### Task 1: Ветка и быстрые тесты

**Files:**
- Modify: `vite.config.ts` (блок `test`)
- Modify: `package.json` (скрипт `test:timing`)

**Interfaces:**
- Produces: `npm test` — тот же набор, быстрее; базовое время 1.0 — 34.9 с (`Duration` из 2026-10-25).

- [ ] **Step 1:** `git switch -c v1.1` от `main`; `git status` — чисто (кроме `tsconfig.tsbuildinfo`, он в `.gitignore` не входит — добавить его в `.gitignore` этим же коммитом).
- [ ] **Step 2:** Замерить: `npx vitest run` — записать `Duration`.
- [ ] **Step 3:** В `test` добавить `pool: 'vmThreads'` (одна среда jsdom на поток, изоляция файлов сохраняется). Если хоть один тест падает только из-за пула (Dexie/fake-indexeddb держат глобальные объекты) — вместо этого `poolOptions: { threads: { isolate: false } }` + в `src/test-setup.ts` `afterEach` закрывать и удалять базы Dexie, созданные тестом (`Dexie.getDatabaseNames()` → `Dexie.delete`).
- [ ] **Step 4:** `npx vitest run` — 360/360, `Duration` меньше базового. Если ни один вариант не быстрее — оставить как было и записать замер в описание коммита.
- [ ] **Step 5:** Commit `test: one jsdom environment per worker`.

### Task 2: Синхронизация — офлайн, повтор, конфликт правок

**Files:**
- Test: `src/db/sync.test.ts` (новый `describe('field reality (stage 0)')`)

**Interfaces:**
- Consumes: `createSync(db, remote, opts)` и тестовый `Remote` из существующего `sync.test.ts`.

- [ ] **Step 1: Тесты (поведение 1.0, должны пройти без правок кода; если какой-то падает — это найденная ошибка, чинить в `sync.ts` в этом же шаге):**
  - `offline push keeps rows dirty and reports error, next sync sends them` — `push` бросает `TypeError('Failed to fetch')`: после `syncOnce()` у строки `dirty === 1`, `result.error` содержит `Failed to fetch`; затем `push` работает — после второго `syncOnce()` `dirty === 0`, на сервере одна строка.
  - `a row saved twice while offline goes out once with the latest content` — две правки одной строки офлайн → после восстановления сети сервер получил одну строку с последним `note`.
  - `two devices edit the same row: the later push wins on both after pull` — два `LocalDb` («phone», «pc») на одном фейковом сервере; оба правят `note`; phone синхронизирует, затем pc, затем phone снова → у обоих `note` от pc.
  - `pull while the row is dirty keeps the local edit` — уже есть (`does not overwrite a locally dirty row`), не дублировать.
- [ ] **Step 2:** `npx vitest run src/db/sync.test.ts` — PASS.
- [ ] **Step 3:** Commit `test(sync): offline, retry and two-device conflict`.

### Task 3 (часть этапа 0): iPhone-оболочка — иконка, обновление версии, вырез

**Files:**
- Modify: `index.html`, `src/main.tsx`
- Create: `src/pwa-update.ts`, `src/pwa-update.test.ts`, `docs/checklists/iphone-1.1.md`
- Test: `src/index-html.test.ts`

**Interfaces:**
- Produces: `createUpdateGate(opts: { isEditing(): boolean; apply(): void; doc: Document }): { onNeedRefresh(): void }` — обновление версии применяется, только когда приложение скрыто (`visibilitychange` → `hidden`) или при следующем открытии, и никогда во время открытой формы записи.

- [ ] **Step 1: Тесты:**
  - `src/index-html.test.ts`: читает `index.html` (fs) — есть `viewport-fit=cover`, `apple-mobile-web-app-capable=yes`, `apple-touch-icon` с **относительным** `href="icons/apple-touch-icon.png"` (абсолютный `/icons/…` на GitHub Pages под `/Seafarer-Budget/` указывает мимо).
  - `src/pwa-update.test.ts`: `does not apply while visible`; `applies once the document becomes hidden`; `does not apply while a record form is open even if hidden`, затем применяет при следующем `hidden` после закрытия формы.
- [ ] **Step 2:** Запуск — FAIL (href абсолютный, модуля нет).
- [ ] **Step 3:** `index.html`: `href="icons/apple-touch-icon.png"`. `src/pwa-update.ts` — `createUpdateGate`. `src/main.tsx`: `registerSW({ immediate: true, onNeedRefresh: gate.onNeedRefresh })`, где `apply` = `updateSW(true)`; `isEditing` читает флаг `document.documentElement.dataset.editing === '1'` (его ставит шторка записи на этапе 2; до этого всегда `false`). В `vite.config.ts` `registerType: 'prompt'`.
- [ ] **Step 4:** `npx vitest run src/index-html.test.ts src/pwa-update.test.ts` — PASS; `BUILD_TARGET=pages npx vite build` и в `dist/index.html` ссылка иконки = `/Seafarer-Budget/icons/apple-touch-icon.png` или `icons/…` (проверить глазами, записать в коммит).
- [ ] **Step 5:** `docs/checklists/iphone-1.1.md` — ручная проверка для этапа 7 (Кирилл на iPhone): вырез и «＋» не под чёлкой; клавиатура не закрывает поле суммы в шторке; поле 17 px — страница не увеличивается; офлайн (авиарежим) — приложение открывается, запись сохраняется, после сети уходит; обновление версии не обрывает ввод; иконка на «Домой» — лайм с якорем (удалить старый значок и добавить заново).
- [ ] **Step 6:** Commit `fix(pwa): relative touch icon, update only when hidden; iPhone checklist`.

---

## Этап 1 — данные и расчёты

### Task 4: Миграция 1.1 и проверка SQL на PGlite

**Files:**
- Create: `supabase/migrations/20261101000000_v11.sql`
- Create: `supabase/sql.test.ts` (в `include` vitest добавить `supabase/*.test.ts`)
- Modify: `package.json` (dev: `@electric-sql/pglite`)

**Interfaces:**
- Produces (колонки, все с умолчаниями, чтобы 1.0 продолжал работать):
  - `settings`: `reserve_usd numeric not null default 0 check (reserve_usd >= 0)`, `partner_name text`, `partner_seen_at timestamptz`, `remind_after_days int not null default 2 check (remind_after_days in (0,2,3,5,7))`, `last_reminder_at timestamptz`, `keepalive_at timestamptz`, `daily_summary_owner bool not null default false`, `daily_summary_partner bool not null default false`.
  - `transactions`: `author text not null default 'owner' check (author in ('owner','partner'))`, `archived bool not null default false`.
  - `goal_moves`: `author` (как выше), `source text not null default 'app' check (source in ('app','bot'))`, `created_at timestamptz not null default now()`.
  - `categories`: `color text`, `glyph text` — **отступление от §4**: там «`categories.icon`», но колонка `icon` уже есть и хранит эмодзи для бота; значок интерфейса — новая `glyph` (ключ из 18: cart, coffee, car, home, wifi, health, ticket, doc, gift, plane, shirt, book, fuel, gym, phone, wallet, box, tag). Спецификацию поправить тем же коммитом.
  - `transactions`, `goals`, `limits`, `categories`: `deleted_at timestamptz`, `deleted_batch uuid`.
  - все 7 синхронизируемых таблиц: `base_rev bigint` — rev, который клиент видел при правке (не хранит смысла, только для триггера).
  - `revoke execute on function public.rls_auto_enable() from public, anon, authenticated;` — только если функция существует (`do $$ … if exists … $$`).
  - `set_rev()` дополняется правилами (только при `UPDATE`):
    1. `old.deleted` → `new.deleted := true` (окончательное удаление не снимается);
    2. если `new.base_rev is not null and new.base_rev < old.rev` (клиент не видел последнюю версию) и строка удалена на сервере (`old.deleted_at is not null`), а клиент присылает `deleted_at is null` → сохранить `old.deleted_at`, `old.deleted_batch` (удаление побеждает устаревшую правку; остальные поля правки применяются).
- Produces (тестовая утилита): `openDb(): Promise<PGlite>` в `supabase/sql.test.ts` — PGlite с заглушками Supabase (`create schema auth; create table auth.users(id uuid primary key); create function auth.uid() returns uuid … current_setting('test.uid')::uuid; роли anon, authenticated, service_role; create publication supabase_realtime;`), затем по порядку все файлы `supabase/migrations/*.sql`.

- [ ] **Step 1: Тесты в `supabase/sql.test.ts`:**
  - `migrations apply cleanly on top of 1.0` — `openDb()` не бросает.
  - `1.0 client insert gets defaults` — `insert into transactions (id, kind, amount, currency, rate_usd, amount_usd, account_id, date)` без новых колонок → `author='owner'`, `archived=false`, `deleted_at is null`.
  - `1.0 client update does not wipe new fields` — строка с `author='partner'`, `archived=true`; `insert … on conflict (id) do update set note = excluded.note` (как PostgREST upsert только с колонками 1.0) → `author`, `archived` прежние.
  - `deleted stays deleted` — `update … set deleted=false` при `deleted=true` → остаётся `true`.
  - `stale edit does not resurrect a soft-deleted row` — строка rev=R; помечена `deleted_at=now()` (rev станет R2); затем `update set note='x', deleted_at=null, base_rev=R` → `deleted_at` не null, `note='x'`.
  - `restore by a client that saw the deletion works` — тот же сценарий, но `base_rev=R2` → `deleted_at is null`.
  - `settings check rejects negative reserve` — `reserve_usd=-1` → ошибка.
- [ ] **Step 2:** `npx vitest run supabase/sql.test.ts` — FAIL (миграции нет).
- [ ] **Step 3:** Написать миграцию (функция `set_rev` — `create or replace` с правилами выше; блок `do $$` для колонок `deleted_at/deleted_batch/base_rev` по списку таблиц, как в `init.sql`).
- [ ] **Step 4:** PASS; весь `npm test` зелёный.
- [ ] **Step 5:** Commit `feat(db): v1.1 migration with deletion-wins trigger, tested on PGlite`.

### Task 5: Типы, умолчания, локальная база v2, `alive()`

**Files:**
- Modify: `supabase/functions/_shared/types.ts`, `supabase/functions/_shared/defaults.ts`, `src/db/local.ts`
- Create: `supabase/functions/_shared/alive.ts`, `supabase/functions/_shared/alive.test.ts`
- Test: `supabase/schema-parity.test.ts`

**Interfaces:**
- Produces:
  - `Base` + `base_rev?: number | null`.
  - `SoftDeletable = { deleted_at: string | null; deleted_batch: string | null }`; `Transaction`, `Goal`, `Limit`, `Category` расширяют его.
  - `Settings` + `reserve_usd: number; partner_name: string | null; partner_seen_at: string | null; remind_after_days: 0 | 2 | 3 | 5 | 7; last_reminder_at: string | null; keepalive_at: string | null; daily_summary_owner: boolean; daily_summary_partner: boolean`.
  - `type Author = 'owner' | 'partner'`; `Transaction` + `author: Author; archived: boolean`; `GoalMove` + `author: Author; source: 'app' | 'bot'; created_at: string`.
  - `Category` + `color: string | null; glyph: string | null`.
  - `alive(row: { deleted: boolean; deleted_at?: string | null }): boolean` и `liveRows<T>(rows: T[]): T[]`.
  - `DEFAULT_SETTINGS` получает новые поля (`reserve_usd: 0`, `remind_after_days: 2`, остальное `null`/`false`); `DEFAULT_CATEGORIES` — `color: null, glyph: null, deleted_at: null, deleted_batch: null`.
  - `CATEGORY_STYLE: Record<string, { color: string; glyph: string }>` в `defaults.ts` — встроенные для стандартных (по имени): Продукты `#30B455` cart, Кафе и рестораны `#FF9500` coffee, Транспорт и такси `#0A84FF` car, Жильё и коммуналка `#AF52DE` home, Связь и интернет `#32ADE6` wifi, Здоровье `#FF3B30` health, Развлечения `#FF2D55` ticket, Документы и курсы `#8E8E93` doc, Прочее `#8E8E93` box, Одежда `#5856D6` shirt, Подарки `#FF2D55` gift, Путешествия `#0A84FF` plane, Авто `#FF9500` fuel, Зарплата `#30B455` wallet, Прочий доход `#30B455` wallet. `categoryStyle(c: Category): { color: string; glyph: string }` — свои поля, иначе встроенные, иначе `#8E8E93` tag.
  - Dexie `version(2)`: те же индексы; `upgrade` дописывает умолчания в старые строки (`author:'owner'`, `archived:false`, `deleted_at:null`, `deleted_batch:null`, `goal_moves.source:'app'`, `goal_moves.created_at` = `date + 'T12:00:00Z'`, новые поля настроек по `DEFAULT_SETTINGS`).
- [ ] **Step 1: Тесты:**
  - `alive.test.ts`: `alive({deleted:false, deleted_at:null}) === true`; `deleted:true` → false; `deleted_at:'2026-10-25T…'` → false; без поля `deleted_at` (строка 1.0) → true.
  - `schema-parity.test.ts`: для каждой синхронизируемой таблицы набор полей интерфейса (список в тесте, константы из `types.ts` не нужны) ⊆ колонки из `create table` + `add column` в миграциях (разбор файлов регулярным выражением) — ловит расхождение типов и SQL.
  - в `src/db/repo.test.ts` (новый тест): `v1 database upgrades to v2 with defaults` — Dexie с `version(1)` и строкой транзакции без новых полей → открыть `createDb` → у строки `author 'owner'`, `archived false`, `deleted_at null`.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** Реализовать типы, умолчания, `alive.ts`, Dexie v2. Починить компиляцию мест, где создаются строки (`repo.ts buildTransaction` — `author: 'owner'`, `archived: false`, `deleted_at: null`, `deleted_batch: null`; тестовые фабрики).
- [ ] **Step 4:** `npx tsc --noEmit` и `npm test` — зелёные.
- [ ] **Step 5:** Commit `feat(types): v1.1 fields, alive(), Dexie v2 upgrade`.

### Task 6: Расчёты — живые строки и `dailyBudget`

**Files:**
- Modify: `supabase/functions/_shared/calc.ts`, `supabase/functions/_shared/calc.test.ts`

**Interfaces:**
- Consumes: `alive`, `liveRows` (Задача 5).
- Produces:
  ```ts
  export type DailyBudget =
    | { state: 'ok' | 'overspent' | 'reserve'; days: number; balanceMorningUsd: number; freeMorningUsd: number;
        perDay: number; spentToday: number; leftToday: number }
    | { state: 'no_date'; spentToday: number }
    | { state: 'sea'; spentToday: number }
  export function dailyBudget(input: {
    txs: Transaction[]; rates: FxRate[]; accounts: { id: string; archived: boolean }[];
    reservedUsd: number; settings: Pick<Settings, 'next_contract_date' | 'reserve_usd'>; today: string
  }): DailyBudget
  ```
  `state`: `no_date` — дата не задана; `sea` — `today > дата`; `reserve` — `freeMorning ≤ 0` (perDay 0); `overspent` — `leftToday < 0`; иначе `ok`. `balanceMorningUsd` = `balanceUsd(activeBalances(txs без сегодняшних), rates, today)` — то есть все движения сегодняшней даты откатываются (переводы и обмены внутри дня на USD-баланс почти не влияют, но откатываются тоже). `spentToday` — сумма `amount_usd` живых расходов сегодня (архивные тоже считаются).
  - Все существующие функции (`balances`, `reservedUsd`, `monthReport`, `contractStats`, `goalProgress`, `limitStatus`) пропускают строки, где `!alive(row)`; архивные (`archived`) — считаются.
  - `allowance` остаётся до этапов 2 и 4 (его заменяют Home и бот), помечается `/** @deprecated use dailyBudget — removed in stage 4 */`.
- [ ] **Step 1: Тесты (`calc.test.ts`, `describe('dailyBudget')`), значения из §2 и §8:**
  - $3 600 на руках, посадка через 59 дней (дней = 60), запас 0 → `perDay 60.00`.
  - на следующий день после траты $150 → `perDay 58.47`; ещё через день после $30 → `58.97`.
  - $5 000, запас $1 000, 60 дней → `66.67`.
  - `today 2026-10-22`, посадка `2026-11-01` → `days 11`.
  - траты сегодня $36.68 при perDay $59.67 → `leftToday 22.99`, `state 'ok'`; при тратах $70 → `state 'overspent'`, `leftToday -10.33`.
  - запас больше денег → `state 'reserve'`, `perDay 0`.
  - нет даты → `no_date`; `today` после даты → `sea`; `spentToday` есть в обоих.
  - перевод и обмен сегодня не меняют `balanceMorningUsd`.
  - `today` вычислен `localDate(new Date('2026-10-21T21:30:00Z'), 'Europe/Kyiv')` = `2026-10-22` (00:30 по Киеву) — запись с датой `2026-10-22` считается «сегодня».
  - строка с `deleted_at` не попадает ни в баланс, ни в `monthReport`, ни в `limitStatus`; архивная (`archived: true`) — попадает.
- [ ] **Step 2:** FAIL. **Step 3:** реализовать. **Step 4:** PASS + весь набор. **Step 5:** Commit `feat(calc): dailyBudget and soft-deleted rows`.

### Task 7: Формат сумм 1.1

**Files:**
- Modify: `supabase/functions/_shared/format.ts`, `supabase/functions/_shared/defaults.ts` (`CURRENCY_SYMBOL`), `supabase/functions/_shared/format.test.ts`
- Modify (только ожидания в тестах): `src/**/*.test.tsx`, `supabase/functions/_shared/bot.test.ts`

**Interfaces:**
- Produces: `money(amount: number, currency: string, opts?: { whole?: boolean }): string` — та же сигнатура, новый вид. `CURRENCY_SYMBOL = { USD:'$', UAH:'₴', EUR:'€', PLN:'zł', GBP:'£', TRY:'₺', GEL:'₾' }` (MDL убран — пишется кодом).
- [ ] **Step 1: Тесты `format.test.ts`:** `money(4963.32,'USD')` → `$4,963.32`; `money(1200,'UAH')` → `₴1,200`; `money(12.5,'EUR')` → `€12.50`; `money(90,'MDL')` → `MDL 90`; `money(-12.5,'USD')` → `-$12.50`; `money(1540.4,'USD',{whole:true})` → `$1,540`; `money(0.004,'USD')` → `$0`; `money(100,'XYZ')` → `XYZ 100`.
- [ ] **Step 2:** FAIL. **Step 3:** реализовать. **Step 4:** `npm test` — обновить ожидания в тестах экранов и бота на новый вид (только строки с суммами; логику тестов не менять), пока всё не станет зелёным.
- [ ] **Step 5:** Commit `feat(format): English money format for app and bot`.

### Task 8: CSV в `_shared/` — выгрузка с «Кто» и разбор для импорта

**Files:**
- Create: `supabase/functions/_shared/csv.ts`, `supabase/functions/_shared/csv.test.ts`
- Modify: `src/export.ts` (берёт `toCsv` из `@shared/csv.ts`, оставляет `downloadCsv`, `csvFileName`), `src/export.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function toCsv(txs: Transaction[], categories: Category[], accounts: Account[], partnerName: string | null): string
  export interface ImportRow { line: number; date: string; kind: 'expense' | 'income'; amount: number; currency: string;
    category: string; account: string; note: string; author: Author }
  export function parseCsv(text: string, partnerName: string | null): { rows: ImportRow[]; errors: { line: number; reason: string }[] }
  export function planImport(rows: ImportRow[], existing: Transaction[], categories: Category[], accounts: Account[]):
    { fresh: ImportRow[]; duplicates: ImportRow[]; unknownCategories: string[] }
  ```
  - `toCsv` — как в 1.0, плюс колонка «Кто» (`owner` → «Я», `partner` → `partnerName ?? 'Она'`); пропускает `!alive`.
  - `parseCsv`: BOM снимается; разделитель — «;», если в заголовке есть «;», иначе «,»; кавычки по CSV; колонки ищутся по названию (обязательные «Дата», «Сумма»; «Тип» — «Расход»/«Доход», по умолчанию «Расход»; «Валюта» по умолчанию `UAH`; «Кто» — «Я» → owner, имя второго человека → partner, пусто → owner); сумма с запятой или точкой, пробелы-тысячи; дата `ГГГГ-ММ-ДД` или `ДД.ММ.ГГГГ`. Строки «Перевод», «Обмен», «Корректировка» — в `errors` с причиной «Этот тип не загружается». Нет даты или суммы → `errors` с номером строки (считая заголовок первой).
  - `planImport`: дубль — живая запись с теми же датой, видом, `amount`, `currency`, категорией (по имени), `note` и `author`; категории, которых нет среди живых, — в `unknownCategories` (без повторов).
- [ ] **Step 1: Тесты `csv.test.ts`:**
  - `toCsv adds «Кто»` — запись партнёра при `partnerName 'Маша'` → последняя колонка `Маша`; владельца → `Я`; удалённая (`deleted_at`) не выгружается.
  - `round trip` — набор с записями владельца и партнёра (`partnerName 'Маша'`) и суммами с копейками: `planImport(parseCsv(toCsv(txs, …, 'Маша'), 'Маша').rows, txs, …)` → `fresh.length === 0`, `duplicates.length === txs.length` (Review Focus 4).
  - `accepts comma separator and DD.MM.YYYY` — `Дата,Тип,Сумма,Валюта,Категория,Заметка\n21.10.2026,Расход,"1 200,50",UAH,Продукты,Атб` → одна строка `amount 1200.5`, `date 2026-10-21`.
  - `bad rows are reported by line` — строка без суммы → `errors[0].line === 3`.
  - `unknown category is listed once`.
- [ ] **Step 2:** FAIL. **Step 3:** реализовать; `src/export.ts` реэкспортирует `toCsv` из shared; `src/export.test.ts` — ожидания с новой колонкой. **Step 4:** PASS. **Step 5:** Commit `feat(csv): shared export with «Кто» and CSV import planning`.

### Task 9: Удаление с возвратом, архив трат, импорт — `repo` и синхронизация

**Files:**
- Create: `supabase/functions/_shared/wipe.ts`, `supabase/functions/_shared/wipe.test.ts`
- Modify: `src/db/repo.ts`, `src/db/repo.test.ts`, `src/db/sync.ts`, `src/db/sync.test.ts`

**Interfaces:**
- Consumes: `alive` (Задача 5), `ImportRow` (Задача 8).
- Produces:
  ```ts
  // wipe.ts (shared: приложение и бот /clear)
  export type WipeScope = 'day' | 'week' | 'month' | 'all'
  export type WipeKind = 'expense' | 'income' | 'all'
  export const RESTORE_MS = 24 * 60 * 60 * 1000
  export function wipeFrom(scope: WipeScope, today: string): string | null   // day → today, week → today-6, month → today-29, all → null
  export function selectForWipe(txs: Transaction[], scope: WipeScope, kind: WipeKind, today: string): Transaction[]
    // живые, kind 'all' = expense+income+transfer+exchange+adjustment, дата в [from, today]
  export function restorable(rows: SoftDeletable[], batch: string, nowMs: number): boolean // есть строки батча и не прошло 24 ч
  export function purgeDue(rows: (SoftDeletable & { id: string; deleted: boolean })[], nowMs: number): string[] // id с deleted_at старше 24 ч
  ```
  `repo` получает:
  ```ts
  setArchived(id: string, archived: boolean): Promise<void>
  remove(table: SyncTable, id: string): Promise<string>          // теперь мягко: deleted_at=now, deleted_batch=uuid; возвращает batch
  wipe(scope: WipeScope, kind: WipeKind): Promise<{ batch: string; count: number }>
  wipeAll(): Promise<{ batch: string; count: number }>           // записи + цели + лимиты + свои категории (не из DEFAULT_CATEGORIES по имени)
  restore(batch: string): Promise<number>                         // снимает метку у живых-по-`deleted` строк батча; окончательно удалённые не трогает
  importRows(rows: ImportRow[], opts: { createCategories: boolean }): Promise<{ batch: string; count: number }>
    // новые записи помечены deleted_batch=batch, deleted_at=null; отмена импорта = markBatchDeleted(batch)
  markBatchDeleted(batch: string): Promise<number>
  ```
  `sync.ts`: `toWire` отправляет `base_rev = row.rev ?? null`; в `pullTable` удаление с сервера (`row.deleted` или `row.deleted_at`) применяется **даже если локальная строка грязная** (удаление побеждает), локальная правка отбрасывается.
- [ ] **Step 1: Тесты:**
  - `wipe.test.ts`: при `today 2026-10-22` `wipeFrom('week')` = `2026-10-16`, `'month'` = `2026-09-23`; `selectForWipe` на наборе с датами `2026-09-22`, `2026-09-23`, `2026-10-16`, `2026-10-22`, `2026-10-23` (будущая): month → 3 (без 09-22 и 10-23), week → 2, day → 1, all → 4; `kind 'income'` берёт только доходы; удалённые не выбираются; `purgeDue` — строка с `deleted_at` 25 ч назад → в списке, 23 ч → нет.
  - `repo.test.ts`: `remove is soft and restorable` — после `remove` у строки `deleted false`, `deleted_at` задан; `restore(batch)` → `deleted_at null`; `wipe('day','expense')` трогает только сегодняшние расходы и возвращает count; `restore after one row was purged` — одна строка батча `deleted=true` → `restore` возвращает остальные, её не трогает (Review Focus 5); `wipeAll` не трогает настройки и стандартные категории; `setArchived(id,true)` → `archived true`, `dirty 1`; `importRows` + `markBatchDeleted` убирает ровно импортированное.
  - `sync.test.ts`: `toWire sends base_rev`; `remote deletion beats a local dirty edit` — phone удалил и синхронизировал; pc без сети поправил ту же строку, затем синхронизировал: pull приносит удаление → у pc строка удалена, его правка не отправлена повторно (Review Focus 1, вместе с SQL-тестом Задачи 4).
- [ ] **Step 2:** FAIL. **Step 3:** реализовать. **Step 4:** `npx tsc --noEmit`, `npm test` — зелёные. **Step 5:** Commit `feat(data): soft delete with 24h restore, wipe, archive and import in repo; deletion wins in sync`.

### Task 10: Итог этапов 0–1

- [ ] **Step 1:** `npx tsc --noEmit` — без ошибок; `npm test` — всё зелёное, записать число тестов и время.
- [ ] **Step 2:** `npm audit --omit=dev` — 0 уязвимостей (PGlite — только dev).
- [ ] **Step 3:** Приложение 1.0 (экраны ещё старые) собирается и открывается: `npx vite build` без ошибок; `npx vite preview` → вход, главная, запись траты — работают (бюджет на главной ещё старый — меняется на этапе 2).
- [ ] **Step 4:** Обновить `docs/superpowers/plans/2026-10-25-v11-roadmap.md`: отметить этап 0–1 «готово (дата, коммит)»; записать отступления (колонка `glyph`, `deleted=true` как окончательное удаление, `base_rev`).
- [ ] **Step 5:** Commit `docs(plan): stage 0-1 done`.
