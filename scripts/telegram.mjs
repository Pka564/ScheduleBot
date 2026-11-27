const { BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, MINI_APP_URL, WORKER_URL } = process.env
const commands = [
  ['start', 'Открыть ScheduleBot'], ['schedule', 'Расписание'], ['today', 'Сегодня'],
  ['tomorrow', 'Завтра'], ['help', 'Помощь'], ['admin', 'Управление расписанием'], ['id', 'Мой Telegram ID'],
]
async function telegram(method, body) {
  let response, output
  try {
    response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000), redirect: 'error',
    })
    output = await response.json()
  } catch { throw new Error(`${method}: не удалось связаться с Telegram`) }
  if (!response.ok || !output.ok) throw new Error(`${method}: Telegram вернул код ${output.error_code ?? response.status}`)
  return output.result
}
function https(input) {
  try { const url = new URL(input); return url.protocol === 'https:' && !url.username && !url.password ? url : undefined }
  catch { return undefined }
}
try {
  const app = https(MINI_APP_URL), worker = https(WORKER_URL)
  if (!BOT_TOKEN || !app || !worker || !/^[A-Za-z0-9_-]{1,256}$/.test(TELEGRAM_WEBHOOK_SECRET ?? ''))
    throw new Error('Установите BOT_TOKEN, WORKER_URL, MINI_APP_URL и TELEGRAM_WEBHOOK_SECRET')
  const webhook = new URL('/api/telegram', worker).href
  await telegram('setWebhook', { url: webhook, secret_token: TELEGRAM_WEBHOOK_SECRET, allowed_updates: ['message', 'callback_query'] })
  await telegram('setMyCommands', { commands: commands.map(([command, description]) => ({ command, description })) })
  await telegram('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Расписание', web_app: { url: app.href } } })
  const status = await telegram('getWebhookInfo', {})
  if (status.url !== webhook) throw new Error('Telegram не подтвердил адрес webhook')
  console.log('Webhook, команды и кнопка «Расписание» настроены.')
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
