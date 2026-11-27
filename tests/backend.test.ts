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
const env: Env = { DB: undefined as unknown as D1Database, BOT_TOKEN: 'local-test-token', ADMIN_TELEGRAM_IDS: '101', TELEGRAM_WEBHOOK_SECRET: 'test-secret', MINI_APP_URL: 'https://example.test/ScheduleBot/' }
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
const request = (path: string, init?: RequestInit) => app.fetch(new Request('https://worker.test/api/' + path, init), env, ctx)
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
