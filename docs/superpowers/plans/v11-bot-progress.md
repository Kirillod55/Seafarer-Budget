# v1.1 bot — progress ledger (stages 4–6)

One line per finished task: stage.task — what — commit.

- 4.1 alive filters, /undo skips bin, restorePatch — eca1a20
- 4.3–4.4 parser: currency typos, number words/slang, dates, quantity, fuzzy accounts, dictionary — 9166364
- 4.5 several records per message (multi.ts) — 910f0c3
- 4.2,4.6–4.13 bot/*.ts: two chats, replies, edits by reply, categories, groups 1–7, /help, /clear, удали <описание> — 1766e53 (+ tests next commit)
- 4.14 index.ts: PARTNER_CHAT_ID, chat map, sendDocument — d852863
- 4 stage done; allowance removed; roadmap updated
- 5.1 groq.ts: request, schema, validation, fallback, cap — e3f2552
- 5.2–5.4 voice, AI after rules, index.ts Groq port — 790c08b; stage 5 done
- 6.1–6.3 keepalive.ts (reminder, summary, webhook, rates, purge, cleanup, backup, handler) — e9b9ff7
- 6.4 /ping — 9b8b820
- 6.5 keepalive Edge Function, workflow, pages.yml, fx batch, README — 21a7a2c, eff7743, fb3163b; stage 6 done
