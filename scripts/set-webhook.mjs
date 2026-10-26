// Registers the Telegram webhook and the bot's command menu.
// Usage: node --env-file=.env scripts/set-webhook.mjs
// Needs TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET; BOT_WEBHOOK_URL overrides the function URL.
// Prints Telegram's responses only; the token is never printed.

const DEFAULT_URL = 'https://qvhernqypfbototyisfr.supabase.co/functions/v1/telegram-bot'

const token = process.env.TELEGRAM_BOT_TOKEN
const secret = process.env.TELEGRAM_WEBHOOK_SECRET
const url = process.env.BOT_WEBHOOK_URL || DEFAULT_URL

if (!token || !secret) {
  console.error('Set TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET (e.g. node --env-file=.env scripts/set-webhook.mjs).')
  process.exit(1)
}

async function call(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json = await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }))
  console.log(method, JSON.stringify(json))
  return json
}

const hook = await call('setWebhook', {
  url,
  secret_token: secret,
  allowed_updates: ['message', 'callback_query'],
  drop_pending_updates: true,
})

const commands = await call('setMyCommands', {
  commands: [
    { command: 'today', description: 'Траты за сегодня' },
    { command: 'month', description: 'Итог месяца' },
    { command: 'left', description: 'Сколько можно тратить' },
    { command: 'undo', description: 'Отменить последнюю запись' },
    { command: 'ping', description: 'Проверка связи' },
    { command: 'balance', description: 'Сколько денег' },
    { command: 'settings', description: 'Настройки бота' },
    { command: 'week', description: 'Траты за неделю' },
    { command: 'goals', description: 'Как цели' },
    { command: 'limits', description: 'Как лимиты' },
    { command: 'export', description: 'Выгрузка CSV' },
    { command: 'help', description: 'Как пользоваться ботом и что он умеет' },
  ],
})

if (!hook.ok || !commands.ok) process.exit(1)
