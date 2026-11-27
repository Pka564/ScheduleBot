import { createHmac } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { getPlatformProxy } from 'wrangler'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { mainGroup, type Import, type Lesson } from '../src/shared/model'
import { getDraft, publish, rollback, saveDraft, schedule, telegramUser, type Env } from '../src/worker/core'
import app from '../src/worker/index'
import { processNotifications } from '../src/worker/notifications'
import { instant } from '../src/shared/time'

let engine: Awaited<ReturnType<typeof getPlatformProxy<Env>>>, db: D1Database
const env: Env = { DB: undefined as unknown as D1Database, BOT_TOKEN: '123:local-test-token', ADMIN_TELEGRAM_IDS: '101', TELEGRAM_WEBHOOK_SECRET: 'test-secret', MINI_APP_URL: 'https://example.test/ScheduleBot/' }
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext
const date = '2026-12-01'
const entry = (day: string, title = 'Алгебра'): Lesson => ({
  date: day, pair: 1, title, type: 'lecture', teacher: '', room: '', building: '', start: null, end: null, notes: '', raw: '',
})
const upload = (hash: string, lessons: Lesson[], from = date, to = '2026-12-03'): Import =>
  ({ group: mainGroup, from, to, hash: hash.repeat(64), warnings: [], lessons })
function sign(id: number, seconds = Math.floor(Date.now() / 1000)) {
  const fields = { auth_date: String(seconds), user: JSON.stringify({ id }) }
  const key = createHmac('sha256', 'WebAppData').update(env.BOT_TOKEN!).digest()
  const hash = createHmac('sha256', key).update(Object.entries(fields).map(x => x.join('=')).join('\n')).digest('hex')
  return new URLSearchParams({ ...fields, hash }).toString()
}
const request = (path: string, init?: RequestInit, bindings = env) => app.fetch(new Request('https://worker.test/api/' + path, init), bindings, ctx)
beforeAll(async () => {
  engine = await getPlatformProxy<Env>({ persist: false, envFiles: [] })
  db = engine.env.DB
  env.DB = db
  for (const file of (await readdir('migrations')).sort()) {
    const sql = await readFile('migrations/' + file, 'utf8')
    // D1 exec splits by lines and cannot accept multi-line trigger bodies.
    const statements = sql.split(/;\n(?=CREATE|INSERT|$)/).map(s => s.trim()).filter(Boolean)
    await db.batch(statements.map(s => db.prepare(s)))
  }
}, 20000)
afterAll(async () => { await engine?.dispose() })
it('проверяет подпись, срок действия и права администратора', async () => {
  expect(await telegramUser(sign(101), env.BOT_TOKEN)).toBe('101')
  await expect(telegramUser(sign(101).replace('101', '102'), env.BOT_TOKEN)).rejects.toMatchObject({ status: 401 })
  await expect(telegramUser(sign(101, 1), env.BOT_TOKEN)).rejects.toMatchObject({ status: 401 })
  const path = 'admin/dashboard?group=' + encodeURIComponent(mainGroup)
  expect((await request(path)).status).toBe(401)
  expect((await request(path, { headers: { Authorization: 'tma ' + sign(102) } })).status).toBe(403)
  expect((await request(path, { headers: { Authorization: 'tma ' + sign(101) } })).status).toBe(200)
})
it('публикует атомарно, сохраняет внешние даты, отклоняет старый черновик и восстанавливает предыдущий снимок', async () => {
  const first = await saveDraft(db, '101', upload('a', [entry(date), entry('2026-12-03'), entry(date)]))
  expect(first.lessons).toHaveLength(2)
  await expect(getDraft(db, '102', first.id)).rejects.toMatchObject({ status: 404 })
  const stale = await saveDraft(db, '101', upload('c', []))
  expect(await publish(db, '101', first.id)).toBe(1)
  expect(await publish(db, '101', first.id)).toBe(1)
  await expect(publish(db, '101', stale.id)).rejects.toMatchObject({ status: 409 })
  await expect(saveDraft(db, '101', upload('a', []))).rejects.toMatchObject({ status: 409 })
  await expect(saveDraft(db, '101', upload('5', [entry('2026-11-01')]))).rejects.toMatchObject({ status: 400 })
  const second = await saveDraft(db, '101', upload('b', [], date, date))
  expect(second.diff).toEqual({ added: 0, removed: 1, unchanged: 0 })
  expect(await publish(db, '101', second.id)).toBe(2)
  const data = await schedule(db, mainGroup)
  expect(data).toMatchObject({ version: 2, periods: [{ from: date, to: '2026-12-03' }], lessons: [entry('2026-12-03')] })
  expect(await rollback(db, mainGroup, 1, 2)).toBe(3)
  expect(await schedule(db, mainGroup)).toMatchObject({ version: 3, lessons: [entry(date), entry('2026-12-03')] })
  const result = await request('groups/' + encodeURIComponent(mainGroup) + '/schedule?date=' + date)
  expect(result.status).toBe(200)
  expect(await result.json()).toMatchObject({ lessons: [entry(date)] })
})
it('проверяет webhook secret и защищает от повторной обработки update', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    if (String(input).startsWith('https://api.telegram.org/')) return Response.json({ ok: true, result: {} })
    return original(input, init)
  })
  const body = JSON.stringify({ update_id: 99, message: { from: { id: 101 }, chat: { id: 101, type: 'private' }, text: '/id' } })
  try {
    expect((await request('telegram', { method: 'POST', body })).status).toBe(403)
    const call = () => request('telegram', { method: 'POST', body, headers: { 'X-Telegram-Bot-Api-Secret-Token': env.TELEGRAM_WEBHOOK_SECRET! } })
    expect(await (await call()).json()).toEqual({ ok: true })
    expect(await (await call()).json()).toEqual({ ok: true, duplicate: true })
    expect(fetch.mock.calls.filter(([input]) => String(input).includes('api.telegram.org'))).toHaveLength(1)
  } finally { fetch.mockRestore() }
})
const original = globalThis.fetch
it('уважает подписки, паузы группы, дедупликацию и блокировку бота', async () => {
  const origin = globalThis.fetch
  const delivered: string[] = []
  const call = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    if (!String(input).startsWith('https://api.telegram.org/')) return origin(input, init)
    const { chat_id } = JSON.parse(String(init?.body))
    delivered.push(chat_id)
    return chat_id === '302' ? Response.json({ ok: false, error_code: 403 }, { status: 403 }) :
      Response.json({ ok: true, result: {} })
  })
  try {
    await db.prepare("INSERT INTO users(id,private_chat,morning) VALUES ('301',1,1),('302',1,1),('303',1,0)").run()
    await db.prepare("INSERT INTO group_notification_disabled VALUES (?,'morning')").bind(mainGroup).run()
    const time = instant(date, '07:00')
    await processNotifications(env, time)
    expect(delivered).toEqual([])
    await db.prepare("DELETE FROM group_notification_disabled WHERE group_id=? AND kind='morning'").bind(mainGroup).run()
    await processNotifications(env, time + 300000)
    await processNotifications(env, time + 600000)
    expect(delivered.toSorted()).toEqual(['301', '302'])
    expect(await db.prepare("SELECT blocked FROM users WHERE id='302'").first('blocked')).toBe(1)
  } finally { call.mockRestore() }
})

const command = (updateId: number, userId: number, text: string, overrides: Partial<Env> = {}) => request('telegram', {
  method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': env.TELEGRAM_WEBHOOK_SECRET! },
  body: JSON.stringify({ update_id: updateId, message: { from: { id: userId }, chat: { type: 'private', id: userId }, text } }),
}, { ...env, ...overrides })
const telegramSuccess = () => Response.json({ ok: true, result: {} })
const telegramReject = (code: number) => Response.json({
  ok: false, error_code: code, description: 'private-upstream-detail', parameters: { retry_after: 7 },
}, { status: code })
function fakeTelegram(reply = (_payload: unknown) => telegramSuccess()) {
  const send = vi.fn(reply)
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    if (!String(input).startsWith('https://api.telegram.org/')) return original(input, init)
    expect(String(input)).toBe(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`)
    expect(init?.method).toBe('POST')
    return send(JSON.parse(String(init?.body)))
  })
  return { send, restore: () => fetch.mockRestore() }
}

it('отвечает на /start и /id без ADMIN_TELEGRAM_IDS, запрещает /admin и сохраняет настройки D1', async () => {
  const mock = fakeTelegram()
  const missingAdmin = { ADMIN_TELEGRAM_IDS: undefined }
  try {
    expect((await command(140, 81010, '/start payload', missingAdmin)).status).toBe(200)
    expect(await db.prepare('SELECT group_id,private_chat,blocked FROM users WHERE id=?').bind('81010').first())
      .toEqual({ group_id: mainGroup, private_chat: 1, blocked: 0 })
    await db.prepare("INSERT INTO groups(id) VALUES ('П-62БС')").run()
    await db.prepare("UPDATE users SET group_id='П-62БС', morning=1, blocked=1 WHERE id=?").bind('81010').run()
    expect((await command(141, 81010, '/id@ScheduleBot', missingAdmin)).status).toBe(200)
    expect((await command(142, 81010, '/admin', missingAdmin)).status).toBe(200)
    expect((await command(143, 81010, '/admin', { ADMIN_TELEGRAM_IDS: '101, 81010' })).status).toBe(200)
    expect(mock.send.mock.calls.map(([payload]) => payload)).toMatchObject([
      { chat_id: '81010', text: expect.stringContaining(mainGroup), reply_markup: { inline_keyboard: [[{ text: 'Расписание', web_app: { url: env.MINI_APP_URL } }]] } },
      { chat_id: '81010', text: 'Ваш Telegram ID: 81010' },
      { chat_id: '81010', text: 'Доступ запрещён' },
      { chat_id: '81010', reply_markup: { inline_keyboard: [[{ text: 'Управление', web_app: { url: env.MINI_APP_URL + '?admin=1' } }]] } },
    ])
    expect(await db.prepare('SELECT group_id,morning,blocked FROM users WHERE id=?').bind('81010').first())
      .toEqual({ group_id: 'П-62БС', morning: 1, blocked: 0 })
  } finally { mock.restore() }
})

it('доставляет /start и /id при отказе регистрации в D1 и скрывает исходные данные в диагностике', async () => {
  const mock = fakeTelegram()
  const log = vi.spyOn(console, 'info').mockImplementation(() => undefined)
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  await db.prepare(`CREATE TRIGGER registration_test_failure BEFORE INSERT ON users WHEN NEW.id='81999' BEGIN
    SELECT RAISE(ABORT, 'private-d1-detail'); END`).run()
  try {
    expect((await command(150, 81999, '/start private-payload')).status).toBe(200)
    expect((await command(151, 81999, '/id')).status).toBe(200)
    expect(mock.send).toHaveBeenCalledTimes(2)
    const diagnostic = JSON.stringify([...log.mock.calls, ...warn.mock.calls])
    expect(diagnostic).toContain('database_failed')
    expect(diagnostic).toContain('register_user')
    expect(diagnostic).toContain('api_success')
    for (const secret of ['81999', 'private-d1-detail', 'private-payload', env.BOT_TOKEN!, env.TELEGRAM_WEBHOOK_SECRET!])
      expect(diagnostic).not.toContain(secret)
  } finally {
    mock.restore(); log.mockRestore(); warn.mockRestore()
    await db.prepare('DROP TRIGGER registration_test_failure').run()
  }
})

it('при явном отказе Telegram принять кнопку отправляет обычный ответ', async () => {
  const mock = fakeTelegram(payload => 'reply_markup' in (payload as object) ? telegramReject(400) : telegramSuccess())
  try {
    expect((await command(160, 81010, '/start')).status).toBe(200)
    expect((await command(161, 81010, '/start', { MINI_APP_URL: 'not-a-url' })).status).toBe(200)
    expect(mock.send).toHaveBeenCalledTimes(3)
    expect(mock.send.mock.calls[1][0]).not.toHaveProperty('reply_markup')
    expect(mock.send.mock.calls[2][0]).not.toHaveProperty('reply_markup')
  } finally { mock.restore() }
})

it('снимает claim после отказа 429 и повторяет только доставку, которую Telegram не принял', async () => {
  let attempt = 0
  const mock = fakeTelegram(() => ++attempt === 1 ? telegramReject(429) : telegramSuccess())
  try {
    const failure = await command(170, 81010, '/id')
    expect(failure.status).toBe(503)
    expect(failure.headers.get('Retry-After')).toBe('7')
    expect(await db.prepare('SELECT id FROM telegram_updates WHERE id=170').first()).toBeNull()
    expect((await command(170, 81010, '/id')).status).toBe(200)
    expect(await (await command(170, 81010, '/id')).json()).toEqual({ ok: true, duplicate: true })
    expect(mock.send).toHaveBeenCalledTimes(2)
  } finally { mock.restore() }
})

it('хранит claim при неизвестном результате отправки и сообщает об ошибке без исходного исключения', async () => {
  const mock = fakeTelegram(() => { throw new Error('private-fetch-url') })
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  try {
    expect(await (await command(180, 81010, '/id')).json()).toEqual({ ok: false })
    expect(await (await command(180, 81010, '/id')).json()).toEqual({ ok: true, duplicate: true })
    expect(mock.send).toHaveBeenCalledTimes(1)
    const diagnostic = JSON.stringify(warn.mock.calls)
    expect(diagnostic).toContain('transport')
    expect(diagnostic).not.toContain('private-fetch-url')
  } finally { mock.restore(); warn.mockRestore() }
})

it('не резервирует update при отсутствующем BOT_TOKEN', async () => {
  const mock = fakeTelegram()
  try {
    expect((await command(190, 81010, '/id', { BOT_TOKEN: undefined })).status).toBe(503)
    expect(mock.send).not.toHaveBeenCalled()
    expect((await command(190, 81010, '/id')).status).toBe(200)
    expect(mock.send).toHaveBeenCalledTimes(1)
  } finally { mock.restore() }
})

it('отпускает update после сбоя D1 до отправки и повторяет команду', async () => {
  const mock = fakeTelegram()
  const batch = vi.fn(db.batch.bind(db)).mockRejectedValueOnce(new Error('D1 unavailable'))
  const overrides = { DB: new Proxy(db, { get: (target, key) => key === 'batch' ? batch : Reflect.get(target, key) }) }
  try {
    expect((await command(195, 81010, '/today', overrides)).status).toBe(503)
    expect(mock.send).not.toHaveBeenCalled()
    expect((await command(195, 81010, '/today', overrides)).status).toBe(200)
    expect(mock.send).toHaveBeenCalledTimes(1)
  } finally { mock.restore() }
})

it('регистрирует только одну отправку для одновременной доставки одного update', async () => {
  const mock = fakeTelegram()
  try {
    const replies = await Promise.all([command(196, 81010, '/id'), command(196, 81010, '/id')])
    expect(replies.map(r => r.status)).toEqual([200, 200])
    expect(await Promise.all(replies.map(r => r.json()))).toContainEqual({ ok: true, duplicate: true })
    expect(mock.send).toHaveBeenCalledTimes(1)
  } finally { mock.restore() }
})

it('показывает код 401 от Telegram без описания или повтора отправки', async () => {
  const mock = fakeTelegram(() => telegramReject(401))
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  try {
    expect(await (await command(197, 81010, '/id')).json()).toEqual({ ok: false })
    expect(await (await command(197, 81010, '/id')).json()).toEqual({ ok: true, duplicate: true })
    expect(mock.send).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls).toContainEqual(['schedulebot.telegram', expect.objectContaining({
      event: 'api_failure', method: 'sendMessage', reason: 'rejected', code: 401,
    })])
    expect(JSON.stringify(warn.mock.calls)).not.toContain('private-upstream-detail')
  } finally { mock.restore(); warn.mockRestore() }
})

it('сохраняет ссылку на документ и показывает подтверждение публикации администратору', async () => {
  const apiCalls: { method: string; payload: Record<string, unknown> }[] = []
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    if (!String(input).startsWith('https://api.telegram.org/')) return original(input, init)
    apiCalls.push({ method: new URL(String(input)).pathname.split('/').at(-1)!, payload: JSON.parse(String(init?.body)) })
    return telegramSuccess()
  })
  const deliver = (update: object) => request('telegram', {
    method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': env.TELEGRAM_WEBHOOK_SECRET! },
    body: JSON.stringify(update),
  })
  const from = { id: 101 }, chat = { type: 'private', id: 101 }
  try {
    expect(await (await deliver({ update_id: 210, message: {
      from, chat, document: { file_id: 'mock-file', file_name: 'schedule.xlsx' },
    } })).json()).toEqual({ ok: true })
    const keyboard = apiCalls[0].payload.reply_markup as { inline_keyboard: { web_app: {url: string} }[][] }
    const file = new URL(keyboard.inline_keyboard[0][0].web_app.url).searchParams.get('file')
    expect(await db.prepare('SELECT owner,file_id FROM telegram_files WHERE id=?').bind(file).first())
      .toEqual({ owner: '101', file_id: 'mock-file' })
    const draft = await saveDraft(db, '101', upload('d', []))
    const confirm = { update_id: 211, callback_query: {
      id: 'mock-callback', from, message: { chat }, data: 'confirm:' + draft.id,
    } }
    expect(await (await deliver(confirm)).json()).toEqual({ ok: true })
    expect(await (await deliver(confirm)).json()).toEqual({ ok: true, duplicate: true })
    expect(apiCalls.map(c => c.method)).toEqual(['sendMessage', 'answerCallbackQuery', 'sendMessage'])
    expect(apiCalls[2].payload.reply_markup).toMatchObject({ inline_keyboard: [[{ callback_data: 'publish:' + draft.id }, { callback_data: 'cancel:' + draft.id }]] })
  } finally { fetch.mockRestore() }
})
