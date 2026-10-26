# Этап 6 — защита от засыпания и уборка (план)

**Spec:** §10, §7 (окончательная очистка), §5 п. 7 (итог дня), carry-overs этапов 0–1 и 4 («Этап 6»). Ветка `v1.1-bot`. Ни деплоя, ни сети: Telegram, NBU и база — за портами, в тестах заглушки.

## Устройство

- `_shared/keepalive.ts` (чистый): `handleKeepalive(req, deps, secret)` — `POST` + `X-Keepalive-Secret`, иначе 401; утро (UTC < 12) / вечер. Утро: `keepalive_at`, напоминание, воскресная копия (только Кириллу), проверка вебхука, курсы для «курс уточнится» (пакетно: один запрос NBU на дату, ≤ 31 дата за запуск), окончательная очистка корзины старше 24 ч (`deleted = true`, все 4 мягкие таблицы), удаление `bot_updates` старше 30 дней. Вечер: `keepalive_at`, напоминание, итог дня тем, у кого включён. Ответ `{ok, db_ms, done[]}`.
- Чистые функции: `reminderDue`, `reminderText`, `dailySummary`, `webhookProblem`, `fixPendingRates`.
- `supabase/functions/keepalive/index.ts` (Deno): порты через клиент `service_role` (так `set_rev()` принимает `keepalive_at`/`last_reminder_at` — правило 3), Telegram Bot API, NBU.
- `/ping` по §10: `bot/ping.ts`, порт `BotOptions.ping()` → время ответа базы и `getWebhookInfo`.
- `.github/workflows/keepalive.yml`: 07:17 и 19:17 UTC + вручную; `curl --fail` до 3 попыток через 60 с; при провале — сообщение в Telegram обоим (секреты репозитория) и падение задачи; 1-го числа — коммит `.github/keepalive` в `main` (`contents: write` только у этой задачи); `pages.yml` — `paths-ignore: [".github/keepalive"]`.
- `fx-rates`: пакетный запрос `{dates: [...]}` (≤ 60), ответ — все строки; одиночный `{date}` как раньше (для будущего пакетного `resolvePendingRates` в приложении).

## Задачи

| # | Что | Файлы | Тесты |
|---|---|---|---|
| 1 | Напоминание и итог дня | `_shared/keepalive.ts` | `no records 2 days → one`, `next day silent`, `2 more days → second`, `new record resets`, `0 → never`, `partner gets it too / no partner chat`, `summary only to enabled`, `no records → «ничего не забыли?»` |
| 2 | Проверка вебхука, курсы, очистка, копия | `_shared/keepalive.ts` | `webhook wrong url / recent error / queue > 5`, `pending rate fixed for a date with a rate`, `one NBU call per date`, `bin > 24 h purged`, `bot_updates cutoff`, `Sunday CSV only to owner, rows = records` |
| 3 | `handleKeepalive`: секрет, утро/вечер, ответ | `_shared/keepalive.ts` | `401 without/with wrong secret, nothing written`, `writes keepalive_at`, `morning vs evening jobs` |
| 4 | `/ping` | `bot/ping.ts`, `bot.ts` | `no records written`, `old keepalive_at warns`, `webhook line`, `AI line` |
| 5 | Edge Function, GitHub workflow, `pages.yml`, `fx-rates` пакетом | `keepalive/index.ts`, `.github/workflows/keepalive.yml`, `.github/keepalive`, `fx-rates/handler.ts` | `fx batch` |
