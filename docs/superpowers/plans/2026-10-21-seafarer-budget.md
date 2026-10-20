# Seafarer Budget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Личный учёт бюджета: программа для Windows (.exe) и PWA для iPhone с общей базой в Supabase и Telegram-ботом для быстрого ввода трат.

**Architecture:** Один React-интерфейс работает с локальной IndexedDB (Dexie) и синхронизируется с Postgres в Supabase по счётчику `rev`. Бот и курсы валют — Supabase Edge Functions. Общая логика (парсер сообщений, расчёты, курсы) лежит в `supabase/functions/_shared/` и используется и приложением, и ботом. Tauri 2 упаковывает тот же интерфейс в .exe, GitHub Pages раздаёт его как PWA.

**Tech Stack:** TypeScript, React, Vite, Vitest, Testing Library, fake-indexeddb, Dexie + dexie-react-hooks, @supabase/supabase-js 2, Recharts, vite-plugin-pwa, Tauri 2 (NSIS), Supabase CLI через `npx supabase`, GitHub Actions (`tauri-apps/tauri-action`).

**Spec:** `docs/superpowers/specs/2026-10-21-budget-app-design.md`

## Global Constraints

- Валюты: `UAH`, `USD`, `EUR`, `MDL`; список настраивается в `settings.currencies`. Итоги в `USD`, валюта по умолчанию `UAH`.
- Интерфейс и тексты бота на русском. Светлая и тёмная тема.
- Один пользователь. После создания аккаунта Кирилла регистрация в Supabase Auth выключена.
- `salary_lag_days` по умолчанию 30, месяц = 30.4 дня, пороги лимитов 0.8 и 1.0.
- Синхронизация: задержка после изменения 2000 мс, опрос 60000 мс, перекрытие при pull 50 ревизий.
- Код в `supabase/functions/_shared/` — чистый TypeScript без npm-импортов, относительные импорты с расширением `.ts` (работает и в Deno, и в Vite с `allowImportingTsExtensions`).
- Деньги хранятся как `number`; округление до центов (`round2`) только на выходе агрегатов и при показе.
- Даты — строки `YYYY-MM-DD` в часовом поясе `settings.timezone` (по умолчанию `Europe/Kyiv`).
- Установщик: Tauri 2, NSIS, `installMode: "currentUser"`, без подписи. `productName` = `Seafarer Budget`, `identifier` = `com.seafarer.budget`.
- Секреты (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `OWNER_CHAT_ID`, `OWNER_USER_ID`, пароль) не попадают в репозиторий и в чат. Кирилл вводит их сам: `npx supabase secrets set` и локальный `.env` (в `.gitignore`).

## Review Focus

1. Telegram повторно доставляет тот же update (функция ответила медленно) → трата не должна задублироваться. Тест в Task 7.
2. Трата в 00:30 по Киеву (это ещё вчера по UTC) → записывается на киевскую дату. Тест `localDate` в Task 3.
3. Форматы сумм `80грн`, `$15`, `15$`, `1 200 грн`, `12,50 eur` → разбираются правильно. Тесты в Task 3.
4. Суммы с плавающей точкой (`0.1 + 0.2`) → в отчёте ровно `0.3`. Тест в Task 4.
5. У НБУ нет курса на нужную дату (выходной, сегодня до публикации) → берётся ближайший более ранний курс и `exact: false`. Тест в Task 2.

---

### Task 1: Каркас проекта

**Prereq (Кирилл):** установить Git: `winget install --id Git.Git -e`, перезапустить терминал.

**Files:**
- Create: `package.json`, `tsconfig.json`, `vite.config.ts`, `index.html`, `src/main.tsx`, `src/App.tsx`, `.gitignore`, `.env.example`
- Test: `src/App.test.tsx`

**Interfaces:**
- Produces: alias `@shared` → `supabase/functions/_shared`; скрипты `npm test` (vitest run), `npm run dev`, `npm run build`; env `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`; `BUILD_TARGET=pages` задаёт `base: '/seafarer-budget/'`, иначе `base: './'`.

- [ ] **Step 1:** `git init` в `C:\CLAUDEWORK\budget`, создать Vite React-TS проект в этой папке, добавить vitest, jsdom, @testing-library/react, fake-indexeddb. В `tsconfig.json`: `"allowImportingTsExtensions": true`, `"noEmit": true`. В `.gitignore`: `node_modules`, `dist`, `.env`, `src-tauri/target`.
- [ ] **Step 2: Тест** `App.test.tsx`: рендер `<App/>` показывает текст `Seafarer Budget`.
- [ ] **Step 3:** `npm test` → PASS; `npm run build` → без ошибок.
- [ ] **Step 4: Commit** спецификации, плана и каркаса: `git add -A; git commit -m "chore: scaffold Seafarer Budget"`.

### Task 2: Типы, значения по умолчанию, курсы валют

**Files:**
- Create: `supabase/functions/_shared/types.ts`, `supabase/functions/_shared/defaults.ts`, `supabase/functions/_shared/fx.ts`
- Test: `supabase/functions/_shared/fx.test.ts`

**Interfaces:**
- Produces (`types.ts`):
  ```ts
  export interface Base { id: string; user_id?: string; rev?: number; deleted: boolean }
  export interface Settings extends Base { base_currency: string; default_currency: string; currencies: string[];
    accounts_mode: 'single'|'multi'; status: 'home'|'contract'; next_contract_date: string|null;
    contract_start_date: string|null; contract_end_date: string|null; salary_lag_days: number; timezone: string }
  export interface Account extends Base { name: string; aliases: string[]; is_default: boolean; archived: boolean; sort: number }
  export interface Category extends Base { name: string; kind: 'expense'|'income'; icon: string; keywords: string[]; archived: boolean; sort: number }
  export type TxKind = 'expense'|'income'|'transfer'|'exchange'|'adjustment'
  export interface Transaction extends Base { kind: TxKind; amount: number; currency: string; rate_usd: number; amount_usd: number;
    rate_pending: boolean; account_id: string; to_account_id: string|null; to_amount: number|null; to_currency: string|null;
    category_id: string|null; date: string; note: string; source: 'app'|'bot'; created_at: string }
  export interface Goal extends Base { name: string; target_usd: number; deadline: string|null; archived: boolean }
  export interface GoalMove extends Base { goal_id: string; amount_usd: number; date: string; note: string }
  export interface Limit extends Base { category_id: string; monthly_usd: number }
  export interface FxRate { date: string; currency: string; uah_per_unit: number }
  export const SYNC_TABLES = ['settings','accounts','categories','transactions','goals','goal_moves','limits'] as const
  export type SyncTable = typeof SYNC_TABLES[number]
  ```
- Produces (`defaults.ts`): `DEFAULT_SETTINGS: Omit<Settings,'id'|'deleted'>`, `DEFAULT_CATEGORIES: Omit<Category,'id'|'deleted'>[]` (13 расходных + 2 доходных из спеки, у «Прочее» `keywords: []`), `CURRENCY_SYMBOL: Record<string,string>` (`₴ $ € L`).
- Produces (`fx.ts`): `nbuUrl(date: string): string`, `parseNbu(json: unknown, currencies: string[]): FxRate[]`, `usdRate(rates: FxRate[], currency: string, date: string): { rate: number; exact: boolean } | null`, `round2(n: number): number`.

Ключевые слова категорий по умолчанию (стартовый набор, дальше бот учится): Продукты `продукт, атб, сильпо, магазин, еда`; Кафе `кофе, кафе, обед, ужин, ресторан, бар`; Транспорт `такси, uber, bolt, автобус, метро, бензин, поезд`; Жильё `квартира, аренда, коммуналка, свет, газ, вода`; Связь `связь, интернет, телефон, мобильный`; Здоровье `аптека, врач, лекарства`; Одежда `одежда, обувь`; Развлечения `кино, игры, подписка`; Подарки `подарок`; Путешествия `отель, билет, самолет`; Авто `авто, мойка, сто, шины`; Документы и курсы `курс, медкомиссия, виза, документы`; Зарплата `зп, зарплата`; Прочий доход `доход`.

- [ ] **Step 1: Тесты** `fx.test.ts`:
  - `nbuUrl('2026-10-21')` === `'https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?date=20261021&json'`
  - `parseNbu([{cc:'USD',rate:41.2,exchangedate:'21.10.2026'},{cc:'EUR',rate:44.9,exchangedate:'21.10.2026'},{cc:'GBP',rate:52,exchangedate:'21.10.2026'}], ['UAH','USD','EUR','MDL'])` → USD, EUR и синтетический `{currency:'UAH', uah_per_unit:1}` на `2026-10-21`, без GBP.
  - `usdRate(rates,'USD',d)` → `{rate:1, exact:true}`; `usdRate(rates,'UAH','2026-10-21')` → `rate ≈ 1/41.2`, `exact:true`.
  - Review Focus 5: курсы есть только на `2026-10-17`; `usdRate(rates,'EUR','2026-10-19')` → курс 17-го и `exact:false`. Нет ни одного курса ≤ даты → `null`.
  - `round2(0.1+0.2)` === `0.3`.
- [ ] **Step 2:** `npx vitest run supabase/functions/_shared/fx.test.ts` → FAIL.
- [ ] **Step 3:** реализовать `types.ts`, `defaults.ts`, `fx.ts`.
- [ ] **Step 4:** тест → PASS.
- [ ] **Step 5: Commit** `feat: shared types, defaults, fx`.

### Task 3: Парсер сообщений и даты

**Files:**
- Create: `supabase/functions/_shared/dates.ts`, `supabase/functions/_shared/parser.ts`
- Test: `supabase/functions/_shared/parser.test.ts`, `supabase/functions/_shared/dates.test.ts`

**Interfaces:**
- Consumes: `Category`, `Account` (Task 2).
- Produces:
  ```ts
  // dates.ts
  export function localDate(now: Date, timeZone: string): string
  export function addDays(date: string, days: number): string
  export function daysBetween(from: string, to: string): number
  export function monthOf(date: string): string            // 'YYYY-MM'
  export function prevMonth(month: string): string
  // parser.ts
  export interface ParseContext { currencies: string[]; defaultCurrency: string; categories: Category[];
    accounts: Account[]; accountsMode: 'single'|'multi'; today: string }
  export type Parsed =
    | { type: 'tx'; kind: 'expense'|'income'; amount: number; currency: string; categoryId: string|null;
        accountId: string|null; date: string; note: string; firstWord: string|null }
    | { type: 'goal'; goalName: string; amount: number; currency: string; date: string }
    | { type: 'command'; command: 'today'|'month'|'left'|'undo'|'help' }
    | { type: 'error'; reason: 'no_amount' }
  export const CURRENCY_ALIASES: Record<string, string[]>
  export function parseMessage(text: string, ctx: ParseContext): Parsed
  ```
  `accountId: null` = счёт по умолчанию, `categoryId: null` = не угадана. `amount` у `goal` со знаком.

Правила разбора (то, что тесты не определяют однозначно): текст в нижний регистр; символы валют `₴ $ € L` и буквенные алиасы могут быть приклеены к числу (`80грн`, `$15`, `15$`); группа из 1–3 цифр, за которой через пробел идёт группа ровно из 3 цифр, — это тысячи (`1 200` → 1200); запятая — десятичный разделитель; `+` перед числом — доход; слова `сегодня|месяц|остаток|отмена|помощь` и `/today|/month|/left|/undo|/help` (одно слово в сообщении) — команды; сообщение, начинающееся с `цель`, — цель (имя = слова между `цель` и числом). Категория: первое слово примечания, которое начинается с любого `keyword` категории или с которого начинается `keyword` (длина ≥ 3); доходная категория даёт `kind:'income'`.

- [ ] **Step 1: Тесты** `dates.test.ts`: Review Focus 2 — `localDate(new Date('2026-10-20T21:30:00Z'), 'Europe/Kyiv')` === `'2026-10-21'`; `daysBetween('2026-10-21','2026-11-20')` === 30; `prevMonth('2026-01')` === `'2025-12'`.
- [ ] **Step 2: Тесты** `parser.test.ts` (контекст: категории из `DEFAULT_CATEGORIES` с id = name, счета `Основной` (default) и `Наличные` с alias `нал`, today `2026-10-21`):
  - `кофе 80` → expense, 80, UAH, `Кафе и рестораны`, note `кофе`, firstWord `кофе`
  - `такси 15 eur` → 15, EUR, `Транспорт и такси`
  - `продукты 250 лей` / `продукты 250 леев` / `90 mdl кафе` / `90 lei кафе` → MDL
  - Review Focus 3: `кофе 80грн` → 80 UAH; `$15 такси` и `такси 15$` → 15 USD; `ремонт 1 200 грн` → 1200; `обед 12,50 eur` → 12.5 EUR
  - `+3000 usd` и `зп 3000 usd` → income, `Зарплата`
  - `вчера кофе 80` → date `2026-10-20`
  - режим multi: `кофе 80 нал` → accountId `Наличные`; режим single: тот же текст → accountId `null`, `нал` остаётся в note
  - `непонятное 50` → categoryId `null`, firstWord `непонятное`
  - `цель машина 500` → goal `машина`, +500, UAH; `цель машина -200 usd` → −200 USD
  - `остаток`, `/left` → command left; `отмена` → undo
  - `кофе` → error no_amount
- [ ] **Step 3:** запустить → FAIL. **Step 4:** реализовать. **Step 5:** → PASS.
- [ ] **Step 6: Commit** `feat: message parser and dates`.

### Task 4: Расчёты

**Files:**
- Create: `supabase/functions/_shared/calc.ts`
- Test: `supabase/functions/_shared/calc.test.ts`

**Interfaces:**
- Consumes: типы (Task 2), `usdRate`, `round2` (Task 2), даты (Task 3).
- Produces:
  ```ts
  export function balances(txs: Transaction[], accountId?: string): Record<string, number>
  export function balanceUsd(bal: Record<string, number>, rates: FxRate[], today: string): number
  export function reservedUsd(moves: GoalMove[], goalId?: string): number
  export interface MonthReport { totalUsd: number; prevTotalUsd: number;
    byCategory: { categoryId: string; usd: number; share: number }[]; top: Transaction[] }
  export function monthReport(txs: Transaction[], month: string): MonthReport
  export type Allowance = { status: 'ok'; days: number; perDay: number; perMonth: number } | { status: 'no_date' } | { status: 'expired' }
  export function allowance(freeUsd: number, s: Settings, today: string): Allowance
  export function contractStats(txs: Transaction[], s: Settings, today: string): { earnedUsd: number; savedThisMonthUsd: number; projectedUsd: number|null }
  export function goalProgress(goal: Goal, moves: GoalMove[], today: string): { savedUsd: number; share: number; etaDate: string|null; perMonthNeeded: number|null }
  export function limitStatus(limit: Limit, txs: Transaction[], month: string): { spentUsd: number; share: number; level: 'ok'|'warn'|'over' }
  export function limitCrossing(before: number, after: number): 'warn'|'over'|null
  ```
  Знаки в `balances`: expense −amount, income +amount, adjustment +amount (со знаком); transfer −amount на `account_id`, +amount на `to_account_id`; exchange −amount `currency`, +`to_amount` `to_currency`. Удалённые не учитываются.

- [ ] **Step 1: Тесты:**
  - `balances`: adjustment 5000 UAH, expense 80 UAH, exchange 4120 UAH → 100 USD ⇒ `{UAH: 800, USD: 100}`; transfer между счетами не меняет общий итог, но меняет `balances(txs, accountId)`.
  - `monthReport`: Review Focus 4 — две траты `amount_usd` 0.1 и 0.2 в одной категории ⇒ `usd === 0.3`; категории отсортированы по убыванию; `top` не длиннее 5; `prevTotalUsd` за прошлый месяц.
  - `allowance(3040, {status:'home', next_contract_date:'2026-11-20', salary_lag_days:30}, '2026-10-21')` ⇒ days 60, perDay 50.67, perMonth 1540.27; без даты ⇒ `no_date`; дата+лаг ≤ сегодня ⇒ `expired`.
  - `goalProgress`: цель $1000, отложено $250 равномерно за 90 дней ⇒ share 0.25, etaDate через ~270 дней; при дедлайне через 6 месяцев `perMonthNeeded` = 125.
  - `limitStatus`: лимит $100, потрачено $79 ⇒ `ok`, $80 ⇒ `warn`, $100 ⇒ `over`; `limitCrossing(0.79, 0.81)` ⇒ `'warn'`, `(0.81, 0.9)` ⇒ `null`, `(0.95, 1.02)` ⇒ `'over'`.
  - `contractStats`: доходы после `contract_start_date` суммируются в `earnedUsd`.
- [ ] **Step 2:** → FAIL. **Step 3:** реализовать. **Step 4:** → PASS.
- [ ] **Step 5: Commit** `feat: budget calculations`.

### Task 5: Схема базы в Supabase

**Prereq (Кирилл):** аккаунт Supabase, новый проект (регион Frankfurt). В Auth создать пользователя со своим email и паролем, затем в Auth → Providers выключить «Allow new users to sign up». В терминале `npx supabase login` (браузер) и `npx supabase link --project-ref <ref>`. Заполнить `.env` по `.env.example`.

**Files:**
- Create: `supabase/config.toml` (через `npx supabase init`), `supabase/migrations/20261021000000_init.sql`, `scripts/verify-db.mjs`

**Interfaces:**
- Produces: таблицы из спеки, раздел 3 (поля = типы Task 2) + `fx_rates(date, currency, uah_per_unit, primary key(date, currency))` + `bot_updates(update_id bigint primary key, created_at timestamptz default now())`.

Миграция:
- `create sequence rev_seq`; функция-триггер `set_rev()` ставит `new.rev := nextval('rev_seq')` before insert or update на всех таблицах из `SYNC_TABLES`.
- `user_id uuid not null default auth.uid() references auth.users`; индекс `(user_id, rev)`.
- RLS на всех `SYNC_TABLES`: политика `owner_all` `using (user_id = auth.uid()) with check (user_id = auth.uid())`. `fx_rates`: select для `authenticated`, без insert/update политик. `bot_updates`: RLS включён, политик нет (только service role).
- `alter publication supabase_realtime add table` всех `SYNC_TABLES`.

- [ ] **Step 1:** написать миграцию и `scripts/verify-db.mjs`: входит как владелец из `.env`, вставляет категорию → `rev` не null; обновляет → `rev` вырос; анонимный клиент без входа читает `categories` → 0 строк; удаляет тестовую строку; печатает `DB OK`.
- [ ] **Step 2:** `npx supabase db push` → миграция применена.
- [ ] **Step 3:** `node --env-file=.env scripts/verify-db.mjs` → `DB OK`.
- [ ] **Step 4: Commit** `feat: supabase schema with RLS and rev sync`.

### Task 6: Функция курсов `fx-rates`

**Files:**
- Create: `supabase/functions/fx-rates/index.ts`

**Interfaces:**
- Consumes: `nbuUrl`, `parseNbu` (Task 2).
- Produces: `POST /functions/v1/fx-rates` с телом `{ date: 'YYYY-MM-DD' }` и JWT пользователя → `FxRate[]` на эту дату. Если в `fx_rates` на дату уже есть строки, возвращает их без запроса в НБУ; иначе запрашивает НБУ, вставляет (service role) и возвращает. Пустой ответ НБУ → `[]` (клиент возьмёт ближайший ранний курс). CORS: `Access-Control-Allow-Origin: *`, обработка `OPTIONS`.

- [ ] **Step 1:** реализовать; `npx supabase functions deploy fx-rates`.
- [ ] **Step 2: Проверка:** вызов из `scripts/verify-db.mjs` (дописать) с датой `2026-10-20` → массив с `USD`, `EUR`, `MDL`, `UAH`; повторный вызов → те же данные из кэша.
- [ ] **Step 3: Commit** `feat: fx-rates edge function`.

### Task 7: Telegram-бот

**Prereq (Кирилл):** создать бота у @BotFather. Узнать свой chat id (бот на `/start` от неизвестного чата ничего не отвечает, поэтому id берётся из логов функции: `npx supabase functions logs telegram-bot`). Задать секреты: `npx supabase secrets set TELEGRAM_BOT_TOKEN=... TELEGRAM_WEBHOOK_SECRET=<случайная строка> OWNER_CHAT_ID=... OWNER_USER_ID=<uuid из Auth>`.

**Files:**
- Create: `supabase/functions/_shared/bot.ts`, `supabase/functions/telegram-bot/index.ts`, `supabase/functions/telegram-bot/store.ts`, `scripts/set-webhook.mjs`
- Test: `supabase/functions/_shared/bot.test.ts`

**Interfaces:**
- Consumes: `parseMessage` (Task 3), `localDate`, `monthOf` (Task 3), `allowance`, `balances`, `balanceUsd`, `reservedUsd`, `limitStatus`, `limitCrossing`, `monthReport` (Task 4), `usdRate`, `round2` (Task 2).
- Produces (`bot.ts`):
  ```ts
  export interface BotStore {
    seenUpdate(updateId: number): Promise<boolean>        // true, если уже был; иначе запоминает и false
    settings(): Promise<Settings|null>
    categories(): Promise<Category[]>; accounts(): Promise<Account[]>; goals(): Promise<Goal[]>
    goalMoves(): Promise<GoalMove[]>; limits(): Promise<Limit[]>
    transactions(): Promise<Transaction[]>                 // все неудалённые
    rates(): Promise<FxRate[]>                             // известные курсы; при необходимости подтягивает курс на сегодня
    insertTx(t: Transaction): Promise<void>; updateTx(id: string, patch: Partial<Transaction>): Promise<void>
    insertGoalMove(m: GoalMove): Promise<void>; updateCategory(id: string, patch: Partial<Category>): Promise<void>
  }
  export interface BotReply { method: 'sendMessage'|'answerCallbackQuery'|'editMessageText'; payload: Record<string, unknown> }
  export function handleUpdate(update: any, ownerChatId: number, store: BotStore, now: Date, uuid: () => string): Promise<BotReply[]>
  ```
  `callback_data`: `c:<txId>:<categorySort>` — переложить в категорию; `u:<txId>` — отменить. Отмена = мягкое удаление (`deleted: true`).

- [ ] **Step 1: Тесты** `bot.test.ts` с in-memory `BotStore` (курс USD 41.2, EUR 44.9, на сегодня):
  - сообщение из чужого chat id → `[]`, в базе ничего
  - Review Focus 1: один и тот же `update_id` дважды → вторая обработка возвращает `[]`, в базе одна трата
  - нет `settings` → ответ содержит `Сначала открой приложение`
  - `кофе 80` → expense с `source:'bot'`, `amount_usd` 1.94; текст ответа содержит `Кафе и рестораны · 80 ₴ ($1.94)` и кнопку `u:<id>`
  - `непонятное 50` → трата в `Прочее`, клавиатура с кнопками `c:<id>:<sort>` по расходным категориям
  - callback `c:<id>:<sort Здоровье>` → у траты категория `Здоровье`, в её `keywords` добавлено `непонятное`, есть `answerCallbackQuery`
  - лимит Кафе $100, уже потрачено $79, `кофе 80` → ответ содержит `⚠️` и `Кафе за месяц: $80.94 из $100`
  - `отмена` → последняя трата из бота помечена `deleted`, ответ начинается с `Удалено:`
  - `цель машина 500` при существующей цели `Машина` → GoalMove на +12.14 USD; `цель дом 100` без такой цели → ответ `Цель «дом» не найдена` и список целей
  - `остаток` при `next_contract_date` → ответ содержит `в месяц`
  - `/month` → итог месяца в USD и строки по категориям по убыванию; `/today` → список сегодняшних трат и сумма
  - `кофе` → ответ с примерами (`/help`)
- [ ] **Step 2:** → FAIL. **Step 3:** реализовать `bot.ts`. **Step 4:** → PASS.
- [ ] **Step 5:** `telegram-bot/index.ts`: `Deno.serve`; неверный заголовок `X-Telegram-Bot-Api-Secret-Token` → 401; иначе `handleUpdate`, ответы отправляются `fetch` в `https://api.telegram.org/bot<token>/<method>`; ошибки пишутся в лог, функция всё равно возвращает 200 (чтобы Telegram не повторял). `store.ts` реализует `BotStore` через supabase-js (`npm:@supabase/supabase-js@2`, service role) с фильтром `user_id = OWNER_USER_ID`. `scripts/set-webhook.mjs` вызывает `setWebhook` с `secret_token` и `setMyCommands` (today, month, left, undo, help с русскими описаниями).
- [ ] **Step 6:** `npx supabase functions deploy telegram-bot --no-verify-jwt`; Кирилл запускает `node --env-file=.env scripts/set-webhook.mjs` → `{"ok":true}`.
- [ ] **Step 7: Commit** `feat: telegram bot`. (Живая проверка бота — в Task 13, после первого запуска приложения, которое создаёт настройки.)

### Task 8: Локальная база и синхронизация

**Files:**
- Create: `src/db/local.ts`, `src/db/repo.ts`, `src/db/sync.ts`, `src/db/remote-supabase.ts`, `src/db/scheduler.ts`, `src/supabase.ts`
- Test: `src/db/repo.test.ts`, `src/db/sync.test.ts`

**Interfaces:**
- Consumes: типы и `DEFAULT_*` (Task 2), `usdRate` (Task 2).
- Produces:
  ```ts
  // local.ts — Dexie: все SYNC_TABLES (индексы 'id, dirty, rev'), fx_rates ('[date+currency]'), meta ('key')
  export type Row<T> = T & { dirty: 0|1 }
  export const db: LocalDb; export function createDb(name: string): LocalDb
  // repo.ts
  export function createRepo(db: LocalDb, deps: { now(): Date; uuid(): string; onChange(): void }): Repo
  export interface Repo {
    put<T extends Base>(table: SyncTable, row: Partial<T>): Promise<T>   // новый id при отсутствии, deleted=false, dirty=1
    remove(table: SyncTable, id: string): Promise<void>                   // deleted=true, dirty=1
    addTransaction(input: Omit<Transaction, 'id'|'deleted'|'rate_usd'|'amount_usd'|'rate_pending'|'created_at'>): Promise<Transaction>
    initDefaults(mode: 'single'|'multi', opening: { currency: string; amount: number; accountName?: string }[]): Promise<void>
  }
  // sync.ts
  export interface Remote { push(table: SyncTable, rows: object[]): Promise<{ id: string; rev: number }[]>;
    pull(table: SyncTable, sinceRev: number): Promise<object[]>; fxRates(date: string): Promise<FxRate[]> }
  export function createSync(db: LocalDb, remote: Remote, opts?: { overlap?: number }): { syncOnce(): Promise<{ pushed: number; pulled: number; error?: string }> }
  // scheduler.ts
  export function startScheduler(sync: { syncOnce(): Promise<unknown> }, opts: { debounceMs: number; pollMs: number; subscribe(cb: () => void): () => void }): { kick(): void; stop(): void; status$: ... }
  ```
  Порядок в `syncOnce`: для каждой таблицы push dirty (поле `dirty` не отправляется), проставить `rev`, снять `dirty`; затем pull с `max(0, last_rev − overlap)`, применять строки, кроме тех, что локально `dirty`; сохранить `meta.last_rev:<table>`; затем для транзакций с `rate_pending` получить курсы по их датам через `remote.fxRates`, пересчитать и пометить `dirty` (уйдут при следующем проходе). Ошибка сети → результат с `error`, `dirty` строки остаются.

- [ ] **Step 1: Тесты** `repo.test.ts` (fake-indexeddb): `put` даёт uuid и `dirty:1`; `addTransaction` 80 UAH при курсе на дату → `amount_usd` 1.94 и `rate_pending:false`, без курса на дату → ближайший ранний и `rate_pending:true`; `initDefaults('single', [{currency:'UAH', amount:5000}])` → 1 счёт `Основной` (default), 15 категорий, 1 adjustment, настройки с `accounts_mode:'single'`.
- [ ] **Step 2: Тесты** `sync.test.ts` с in-memory `Remote`: push снимает `dirty` и ставит `rev`; pull приносит строку, созданную «ботом» на сервере; локально `dirty` строка не перезаписывается pull'ом; удаление доходит до другой копии; при `push` с ошибкой `dirty` остаётся, `error` заполнен; `rate_pending` транзакция после sync получает точный курс; перекрытие: строка с `rev` меньше `last_rev`, но в пределах 50, применяется.
- [ ] **Step 3:** → FAIL. **Step 4:** реализовать `local.ts`, `repo.ts`, `sync.ts`, `scheduler.ts`, `remote-supabase.ts` (upsert/select по `rev`, `functions.invoke('fx-rates')`, Realtime `postgres_changes` для `subscribe`). **Step 5:** → PASS.
- [ ] **Step 6: Commit** `feat: local db and sync`.

### Task 9: Вход, первый запуск, главный экран

**Files:**
- Create: `src/screens/Login.tsx`, `src/screens/Wizard.tsx`, `src/screens/Home.tsx`, `src/components/QuickInput.tsx`, `src/components/SyncBadge.tsx`, `src/components/TxList.tsx`, `src/styles.css`, `src/format.ts`
- Modify: `src/App.tsx`
- Test: `src/screens/Wizard.test.tsx`, `src/components/QuickInput.test.tsx`, `src/screens/Home.test.tsx`

**Interfaces:**
- Consumes: `Repo`, `startScheduler` (Task 8), `parseMessage` (Task 3), `allowance`, `balances`, `balanceUsd`, `reservedUsd` (Task 4).
- Produces: `App` переключает экраны через состояние `screen: 'home'|'record'|'report'|'goals'|'limits'|'accounts'|'settings'` и нижнюю навигацию; `format.ts`: `money(amount: number, currency: string): string` (`80 ₴`, `$1.94`, `12,50 €`, `90 L`).

- [ ] **Step 1: Тесты:**
  - `Wizard`: выбор «Один баланс», ввод 5000 ₴, «Готово» → `initDefaults('single', [{currency:'UAH', amount:5000}])`.
  - `QuickInput`: ввод `такси 15 eur` + Enter → `addTransaction` с EUR и категорией `Транспорт и такси`, поле очищено; ввод `кофе` → подсказка с примером, без записи.
  - `Home`: при настройках из примера allowance показывает `$1 540 в месяц` и `$51 в день`; без даты контракта — кнопка «Указать дату контракта»; в статусе `contract` вместо этого блок «Заработано за контракт» и «Отложено в этом месяце» из `contractStats`.
- [ ] **Step 2:** → FAIL. **Step 3:** реализовать; `App` показывает `Login`, если нет сессии, `Wizard`, если нет настроек, иначе экраны. **Step 4:** → PASS.
- [ ] **Step 5: Проверка вручную:** `npm run dev`, вход, мастер, `кофе 80` в быстрой строке → запись видна в списке и через ~2 с в таблице `transactions` в панели Supabase.
- [ ] **Step 6: Commit** `feat: login, first-run wizard, home`.

### Task 10: Запись и отчёт

**Files:**
- Create: `src/screens/Record.tsx`, `src/screens/Report.tsx`
- Test: `src/screens/Record.test.tsx`, `src/screens/Report.test.tsx`

**Interfaces:**
- Consumes: `Repo` (Task 8), `monthReport` (Task 4), `money` (Task 9).

- [ ] **Step 1: Тесты:** `Record` открывает существующую трату, смена суммы 80 → 120 сохраняет её с пересчётом `amount_usd` и `dirty:1`; «Удалить» вызывает `remove`; поле «Счёт» видно только в режиме `multi`. `Report` за `2026-10`: категории по убыванию с долями, строка «на X% больше/меньше, чем в сентябре», топ-5, стрелки переключения месяца.
- [ ] **Step 2:** → FAIL. **Step 3:** реализовать (круговая диаграмма — Recharts `PieChart`). **Step 4:** → PASS.
- [ ] **Step 5: Commit** `feat: record form and monthly report`.

### Task 11: Цели, лимиты, счета

**Files:**
- Create: `src/screens/Goals.tsx`, `src/screens/Limits.tsx`, `src/screens/Accounts.tsx`
- Test: `src/screens/Goals.test.tsx`, `src/screens/Limits.test.tsx`, `src/screens/Accounts.test.tsx`

**Interfaces:**
- Consumes: `Repo` (Task 8), `goalProgress`, `limitStatus`, `balances` (Task 4).

- [ ] **Step 1: Тесты:** `Goals`: создать цель «Машина» $15 000, «Отложить» 500 ₴ → GoalMove в USD по курсу дня, прогресс обновился; «Забрать» создаёт отрицательный GoalMove. `Limits`: задать лимит Кафе $100 → полоска с `spentUsd`, цвет по уровню. `Accounts`: перевод 1000 ₴ с `Основной` на `Наличные` → transfer, балансы счетов изменились; обмен 4120 ₴ → $100 → exchange.
- [ ] **Step 2:** → FAIL. **Step 3:** реализовать. **Step 4:** → PASS.
- [ ] **Step 5: Commit** `feat: goals, limits, accounts`.

### Task 12: Настройки и экспорт

**Files:**
- Create: `src/screens/Settings.tsx`, `src/export.ts`
- Test: `src/screens/Settings.test.tsx`, `src/export.test.ts`

**Interfaces:**
- Consumes: `Repo` (Task 8).
- Produces: `toCsv(txs: Transaction[], categories: Category[], accounts: Account[]): string` — UTF-8 с BOM (для Excel), разделитель `;`, заголовок `Дата;Тип;Сумма;Валюта;Сумма USD;Категория;Счёт;Заметка`.

- [ ] **Step 1: Тесты:** `toCsv` — заголовок как выше, BOM в начале, `12.5` выводится как `12,5`, удалённые не попадают. `Settings`: переключение `single → multi → single` не удаляет счета и записи; статус «дома»/«в рейсе» с датами сохраняется; добавление валюты `PLN` в список; «Сверка»: при балансе 4920 ₴ ввод реальных 4800 ₴ создаёт adjustment −120 ₴; переименование и архивирование категории (архивная не показывается в выборе, старые записи сохраняют её); «Выйти» завершает сессию.
- [ ] **Step 2:** → FAIL. **Step 3:** реализовать; экспорт скачивает `seafarer-budget-YYYY-MM-DD.csv`. **Step 4:** → PASS.
- [ ] **Step 5: Commit** `feat: settings and csv export`.

### Task 13: PWA на GitHub Pages и живая проверка бота

**Prereq (Кирилл):** аккаунт GitHub, публичный репозиторий `seafarer-budget`, `git remote add origin ...`, в Settings → Pages выбрать источник «GitHub Actions», в Settings → Secrets добавить `VITE_SUPABASE_URL` и `VITE_SUPABASE_ANON_KEY`.

**Files:**
- Modify: `vite.config.ts` (vite-plugin-pwa: `registerType: 'autoUpdate'`, манифест `name: 'Seafarer Budget'`, `display: 'standalone'`, иконки 192/512 и `apple-touch-icon` 180), `index.html` (`apple-mobile-web-app-capable`, `theme-color`), `src/main.tsx` (service worker регистрируется, только если нет `window.__TAURI_INTERNALS__`)
- Create: `public/icons/*`, `.github/workflows/pages.yml` (на push в `main`: `npm ci`, `npm test`, `BUILD_TARGET=pages npm run build`, deploy-pages)

- [ ] **Step 1:** реализовать, `git push` → workflow зелёный, сайт открывается по `https://<user>.github.io/seafarer-budget/`.
- [ ] **Step 2: Проверка на iPhone:** Safari → «На экран Домой» → вход → данные с ПК видны. Авиарежим → запись `кофе 80` → выключить авиарежим → запись появилась в Supabase.
- [ ] **Step 3: Проверка бота:** `кофе 80` в Telegram → ответ бота, запись появилась в открытом приложении без перезагрузки (Realtime).
- [ ] **Step 4: Commit** `feat: pwa and pages deploy`.

### Task 14: Программа для Windows

**Files:**
- Create: `src-tauri/` (через `npx tauri init`; `tauri.conf.json`: `productName`, `identifier` из Global Constraints, `bundle.targets: ["nsis"]`, `bundle.windows.nsis.installMode: "currentUser"`, окно 1100×760, CSP разрешает `https://*.supabase.co` и `wss://*.supabase.co`), `.github/workflows/release.yml`

`release.yml`: на тег `v*`, `windows-latest`, `npm ci`, `npm test`, `tauri-apps/tauri-action` создаёт GitHub Release с `Seafarer-Budget-<версия>-setup.exe`; отдельный шаг пакует `src-tauri/target/release/seafarer-budget.exe` в `Seafarer-Budget-<версия>-portable.zip` и прикладывает к релизу.

- [ ] **Step 1:** реализовать, `git tag v1.0.0; git push --tags` → workflow зелёный, в Releases есть setup.exe и portable.zip.
- [ ] **Step 2: Проверка:** скачать setup.exe, установить (SmartScreen: «Подробнее» → «Выполнить в любом случае»), ярлык в меню Пуск, вход, данные те же, что на iPhone; отключить Wi-Fi → программа открывается и принимает записи, после подключения синхронизирует.
- [ ] **Step 3: Commit** `feat: windows installer via tauri`.

### Task 15: Итоговая проверка по спеке

- [ ] **Step 1:** `npm test` → все тесты PASS.
- [ ] **Step 2:** пройти раздел 9 спеки целиком на реальных устройствах; каждое расхождение — исправление с тестом и отдельный коммит.
- [ ] **Step 3:** короткая инструкция для Кирилла `docs/README-ru.md`: как ставить, как писать боту, что делать, если Supabase «уснул» (Dashboard → Restore project).
