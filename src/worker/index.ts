import { preferences, searchLessons, type Preference, type Settings } from '../shared/model'
import { validDate } from '../shared/time'
import { ensureGroup, getDraft, groupId, history, HttpError, isAdmin, jsonBody, publish,
  rateLimit, rollback, saveDraft, schedule, summarizeDraft, telegramUser, type Env } from './core'
import { processNotifications } from './notifications'
import { cancelDraft, postDraft, webhook, workbookFile } from './telegram'

const json = (value: unknown, status = 200) => Response.json(value, { status })
const settingsSql = 'SELECT group_id AS "group",changes,evening,morning,reminder,private_chat FROM users WHERE id=?'
async function settings(env: Env, id: string, request: Request) {
  const db = env.DB
  await db.prepare('INSERT OR IGNORE INTO users(id) VALUES (?)').bind(id).run()
  if (request.method === 'PUT') {
    const x = await jsonBody(request, 4096) as Settings
    if (!groupId(x?.group) || Object.keys(preferences).some(k => typeof x[k as keyof typeof preferences] !== 'boolean'))
      throw new HttpError(400, 'Некорректные настройки')
    await ensureGroup(db, x.group)
    await db.prepare(`UPDATE users SET seen_version=CASE WHEN group_id!=?1 OR changes=0
      THEN COALESCE((SELECT max(number) FROM versions WHERE group_id=?1),0) ELSE seen_version END,
      group_id=?1,changes=?2,evening=?3,morning=?4,reminder=?5 WHERE id=?6`)
      .bind(x.group, Number(x.changes), Number(x.evening), Number(x.morning), Number(x.reminder), id).run()
  } else if (request.method !== 'GET') throw new HttpError(405, 'Метод не поддерживается')
  const result = (await db.prepare(settingsSql).bind(id).first())!
  return json({ ...result, ...Object.fromEntries(Object.keys(preferences).map(key => [key, Boolean(result[key])])), admin: isAdmin(env, id) })
}
async function route(request: Request, env: Env, ctx: ExecutionContext) {
  const url = new URL(request.url), path = url.pathname, method = request.method, db = env.DB
  if (path === '/api/telegram' && method === 'POST') return webhook(request, env)
  if (path === '/api/health' && method === 'GET') {
    await db.prepare('SELECT id FROM groups LIMIT 1').first()
    return json({ ok: true })
  }
  if (!path.startsWith('/api/')) throw new HttpError(404, 'Страница не найдена')
  const ip = request.headers.get('CF-Connecting-IP') ?? 'local'
  const adminRoute = path.startsWith('/api/admin/')
  if (adminRoute || path === '/api/settings') {
    await rateLimit(db, `protected:${ip}`, 45)
    const id = await telegramUser(request.headers.get('Authorization')?.replace(/^tma /, '') ?? '', env.BOT_TOKEN?.trim())
    if (path === '/api/settings') return settings(env, id, request)
    if (!isAdmin(env, id)) throw new HttpError(403, 'Доступ только для администратора')
    const action = path.slice(11)
    const match = /^(file|draft|publish)\/([\da-f-]{36})$/.exec(action)
    if (match) {
      const [, kind, key] = match
      if (kind === 'file' && method === 'GET') return workbookFile(env, id, key)
      if (kind === 'draft' && method === 'GET') return json(await summarizeDraft(db, await getDraft(db, id, key)))
      if (kind === 'draft' && method === 'DELETE') { await cancelDraft(env, id, key); return json({ ok: true }) }
      if (kind === 'publish' && method === 'POST') return json({ version: await publish(db, id, key) })
    }
    if (action === 'drafts' && method === 'POST') {
      const draft = await saveDraft(db, id, await jsonBody(request))
      ctx.waitUntil(postDraft(env, id, draft))
      return json(draft, 201)
    }
    if (action === 'groups' && method === 'POST') {
      const x = await jsonBody(request, 4096) as { group?: string }
      if (!groupId(x?.group)) throw new HttpError(400, 'Введите группу в формате П-61БС')
      await db.prepare('INSERT OR IGNORE INTO groups(id) VALUES (?)').bind(x.group).run()
      return json({ ok: true }, 201)
    }
    if (action === 'dashboard' && method === 'GET') {
      const group = url.searchParams.get('group') ?? ''
      await ensureGroup(db, group)
      const stats = await db.prepare('SELECT count(*) users, sum(private_chat AND NOT blocked AND (changes OR morning OR evening OR reminder)) subscribers FROM users WHERE group_id=?').bind(group).first()
      const disabled = (await db.prepare('SELECT kind FROM group_notification_disabled WHERE group_id=?').bind(group).all()).results.map(r => r.kind)
      return json({ disabled, versions: await history(db, group), users: stats?.users ?? 0, subscribers: stats?.subscribers ?? 0 })
    }
    if (action === 'notifications' && method === 'PUT') {
      const x = await jsonBody(request, 4096) as { group: string; kind: Preference; enabled: boolean }
      if (!groupId(x?.group) || !Object.hasOwn(preferences, x.kind) || typeof x.enabled !== 'boolean')
        throw new HttpError(400, 'Некорректные настройки рассылки')
      await ensureGroup(db, x.group)
      await db.prepare(x.enabled ? 'DELETE FROM group_notification_disabled WHERE group_id=? AND kind=?' :
        'INSERT OR IGNORE INTO group_notification_disabled VALUES (?,?)').bind(x.group, x.kind).run()
      return json({ ok: true })
    }
    if (action === 'rollback' && method === 'POST') {
      const x = await jsonBody(request, 4096) as { group: string; target: number; current: number }
      if (!groupId(x?.group) || !Number.isInteger(x.target) || !Number.isInteger(x.current)) throw new HttpError(400, 'Некорректная версия')
      return json({ version: await rollback(db, x.group, x.target, x.current) })
    }
    if (action === 'holiday' && method === 'PUT') {
      const x = await jsonBody(request, 4096) as { group: string; date: string; enabled: boolean }
      if (!groupId(x?.group) || !validDate(x.date) || typeof x.enabled !== 'boolean') throw new HttpError(400, 'Некорректная дата')
      await ensureGroup(db, x.group)
      await db.prepare(x.enabled ? 'INSERT OR IGNORE INTO holidays VALUES (?,?)' : 'DELETE FROM holidays WHERE group_id=? AND day=?').bind(x.group, x.date).run()
      return json({ ok: true })
    }
    throw new HttpError(404, 'Действие не найдено')
  }
  if (method !== 'GET') throw new HttpError(405, 'Метод не поддерживается')
  await rateLimit(db, `public:${ip}`, 90)
  if (path === '/api/groups') return json((await db.prepare('SELECT id FROM groups ORDER BY id').all()).results.map(r => r.id))
  const match = /^\/api\/groups\/([^/]+)\/(schedule|version|search)$/.exec(path)
  if (!match) throw new HttpError(404, 'Маршрут не найден')
  let group: string
  try { group = decodeURIComponent(match[1]) } catch { throw new HttpError(400, 'Некорректная группа') }
  if (!groupId(group)) throw new HttpError(400, 'Некорректная группа')
  await ensureGroup(db, group)
  if (match[2] === 'version') {
    const [latest] = await history(db, group)
    return json(latest ?? { number: 0, created: null })
  }
  const date = url.searchParams.get('date'), from = date ?? url.searchParams.get('from'), to = date ?? url.searchParams.get('to')
  if (from !== null && !validDate(from) || to !== null && !validDate(to) || from && to && from > to)
    throw new HttpError(400, 'Некорректный диапазон дат')
  const data = await schedule(db, group, from ?? undefined, to ?? undefined)
  if (match[2] === 'search') return json(searchLessons(data.lessons, (url.searchParams.get('q') ?? '').slice(0, 150), url.searchParams.get('type') ?? undefined))
  return json(data)
}
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const origin = request.headers.get('Origin')
    const allowed = origin && (origin === new URL(env.MINI_APP_URL).origin || /^http:\/\/(?:localhost|127\.0\.0\.1):5173$/.test(origin) && new URL(request.url).hostname === 'localhost')
    let response: Response
    try {
      if (origin && !allowed && request.method !== 'GET') throw new HttpError(403, 'Недопустимый источник запроса')
      response = request.method === 'OPTIONS' ? new Response(null, { status: 204 }) : await route(request, env, ctx)
    } catch (err) {
      response = json({ error: err instanceof HttpError ? err.message : 'Ошибка сервера. Попробуйте позднее' }, err instanceof HttpError ? err.status : 500)
    }
    const result = new Response(response.body, response)
    result.headers.set('Vary', 'Origin')
    result.headers.set('Cache-Control', 'no-store')
    result.headers.set('X-Content-Type-Options', 'nosniff')
    if (allowed) {
      result.headers.set('Access-Control-Allow-Origin', origin)
      result.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
      result.headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type')
    }
    return result
  },
  async scheduled(event: ScheduledController, env: Env) {
    await processNotifications(env, event.scheduledTime)
  },
} satisfies ExportedHandler<Env>
