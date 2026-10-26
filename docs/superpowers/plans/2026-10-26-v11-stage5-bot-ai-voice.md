# Этап 5 — голос и живой текст через Groq (план)

**Spec:** §5 «Голосовые сообщения через Groq», «Живой текст: сначала правила, потом ИИ», §10 «Команды обычными словами» (ИИ-часть). Ветка `v1.1-bot`. Все обращения к Groq в тестах — заглушки; сеть не трогаем.

## Устройство

- `_shared/groq.ts` (без npm): порт `GroqPort { chat(model, body), transcribe(audio, filename, prompt) }` — реализует `telegram-bot/index.ts` через `fetch` с таймаутом 6 с; чистые `buildAiRequest`, `aiSchema`, `validateAi`, `askAi` (120b → 20b на 429, суточный счётчик ≤ 300), `voicePrompt`.
- Бот: `BotOptions.groq?: GroqPort`, `BotOptions.voiceFile?(fileId) → Uint8Array` (getFile + скачивание — в `index.ts`). `Ctx.ai` — порт или `null`.
- Голос: `voice`/`audio` ≤ 60 с → `transcribe` (`whisper-large-v3-turbo`, подсказка — категории, счета, валюты) → обычный разбор; первая строка ответа «🎤 Услышал: «…»».
- ИИ зовётся только при неуверенных правилах: `route()` ничего не понял, одна запись ушла в «Прочее», неоднозначный счёт, слово без суммы. Ответ проверяется кодом; уверенный — записывается сразу с «🤖 Понял так:» и учит слово категории; неуверенный или с отброшенным — «🤖 Понял так: …» + «Записать» / «Отмена» (кнопка повторяет запрос, `temperature 0`). Команда от ИИ выполняется, если он уверен, иначе кнопки выбора команды.

## Задачи

| # | Что | Файлы | Тесты |
|---|---|---|---|
| 1 | Запрос, схема, проверка ответа ИИ, 429 → 20b, таймаут/ошибка → null, лимит 300/сутки | `_shared/groq.ts` | `schema strict`, `validate drops foreign category / amount ≤ 0 / future / old / unknown currency / > 20`, `429 falls back`, `both 429 → null`, `throw → null`, `daily cap` |
| 2 | Голосовые: длина, нет ключа, пусто/ошибка, «🎤 Услышал», подсказка | `_shared/bot.ts`, `bot/voice.ts` | `voice → record`, `> 60 s`, `no key`, `empty`, `prompt has categories/accounts` |
| 3 | ИИ после правил: когда звать, «🤖 Понял так», «Записать», обучение, команды, создание категории, сбой | `bot/ai.ts`, `bot/intent.ts` | `кофе 80 never calls AI`, `unsure → button, nothing saved`, `confident → saved + learned, next time no AI`, `timeout → «Не понял — напиши проще»`, `command from AI` |
| 4 | `index.ts`: GroqPort через fetch, getFile, секрет `GROQ_API_KEY` | `telegram-bot/index.ts` | — |
