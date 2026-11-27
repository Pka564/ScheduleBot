import { lessonKey, types, type Import, type Lesson, type Draft, type Schedule, type Version } from '../shared/model'
import { shiftDate, validDate } from '../shared/time'
export interface Env {
  DB: D1Database
  BOT_TOKEN?: string
  ADMIN_TELEGRAM_IDS?: string
  TELEGRAM_WEBHOOK_SECRET?: string
  MINI_APP_URL: string
}
export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message) }
}
export function equal(a: string, b: string) {
  let diff = a.length ^ b.length
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0)
  return diff === 0
}
export const isAdmin = (env: Env, id: string) => (env.ADMIN_TELEGRAM_IDS ?? '').split(/[\s,]+/).includes(id)
export async function telegramUser(data: string, token?: string, now = Date.now()): Promise<string> {
  const invalid = () => new HttpError(401, 'Откройте приложение из меню Telegram')
  if (!token || !data || data.length > 8192) throw invalid()
  const args = new URLSearchParams(data)
  if (new Set(args.keys()).size !== [...args.keys()].length) throw invalid()
  const hash = args.get('hash') ?? ''
  args.delete('hash')
  const authDate = Number(args.get('auth_date'))
  if (!/^[0-9a-f]{64}$/.test(hash) || !Number.isInteger(authDate) || now / 1000 - authDate > 3600 || authDate > now / 1000 + 60) throw invalid()
  const encode = (s: string) => new TextEncoder().encode(s)
  async function sign(key: ArrayBuffer | Uint8Array<ArrayBuffer>, value: string) {
    return crypto.subtle.sign('HMAC', await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']), encode(value))
  }
  args.sort()
  const signature = await sign(await sign(encode('WebAppData'), token), [...args].map(([k, v]) => `${k}=${v}`).join('\n'))
  if (!equal(hash, [...new Uint8Array(signature)].map(n => n.toString(16).padStart(2, '0')).join(''))) throw invalid()
  try {
    const { id } = JSON.parse(args.get('user') ?? '{}')
    if (!Number.isSafeInteger(id) || id < 1) throw invalid()
    return String(id)
  } catch { throw invalid() }
}
export const ttl = 86400000
export const groupId = (v: unknown): v is string => typeof v === 'string' && /^[А-ЯЁA-Z]{1,8}-\d{1,5}[А-ЯЁA-Z]{1,8}$/u.test(v)
export const time = (v: unknown): v is string => typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v)
export function validateImport(input: unknown): Import {
  const fail = () => new HttpError(400, 'Некорректные данные импорта')
  if (!input || typeof input !== 'object') throw fail()
  const { group, from, to, hash, warnings, lessons } = input as Import
  if (!groupId(group) || !validDate(from) || !validDate(to) || from > to || shiftDate(from, 365) < to ||
    typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash) ||
    !Array.isArray(warnings) || warnings.length > 300 || warnings.some(w => typeof w !== 'string' || w.length > 3000) ||
    !Array.isArray(lessons) || lessons.length > 1000) throw fail()
  const unique = new Map<string, Lesson>()
  for (const l of lessons) {
    if (!l || !validDate(l.date) || l.date < from || l.date > to || (l.pair !== null && (!Number.isInteger(l.pair) || l.pair < 1 || l.pair > 7)) ||
      !Object.hasOwn(types, l.type) || typeof l.title !== 'string' || !l.title.trim() ||
      [l.title, l.teacher, l.room, l.building, l.notes, l.raw].some(v => typeof v !== 'string' || v.length > 3000) ||
      (l.start !== null && !time(l.start)) || (l.end !== null && (!time(l.end) || !l.start || l.end <= l.start))) throw fail()
    const { date, pair, title, type, teacher, room, building, start, end, notes, raw } = l
    unique.set(lessonKey(l), { date, pair, title, type, teacher, room, building, start, end, notes, raw })
  }
  return { group, from, to, hash, warnings, lessons: [...unique.values()] }
}
export async function jsonBody(request: Request, limit = 360000): Promise<unknown> {
  if (!request.body) throw new HttpError(400, 'Ожидается JSON')
  const reader = request.body.getReader()
  const buffer = new Uint8Array(limit)
  let size = 0
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    if (size + value.length > limit) { await reader.cancel(); throw new HttpError(413, 'Запрос слишком большой') }
    buffer.set(value, size)
    size += value.length
  }
  try { return JSON.parse(new TextDecoder().decode(buffer.subarray(0, size))) }
  catch { throw new HttpError(400, 'Ожидается JSON') }
}
export async function rateLimit(db: D1Database, key: string, limit: number) {
  const row = await db.prepare('INSERT INTO rate_limits VALUES (?, ?, 1) ON CONFLICT(actor,bucket) DO UPDATE SET hits=hits+1 WHERE hits<? RETURNING hits')
    .bind(key, Math.floor(Date.now() / 60000), limit).first<number>('hits')
  if (row === null) throw new HttpError(429, 'Слишком много запросов. Повторите через минуту')
}
export async function ensureGroup(db: D1Database, group: string) {
  if (!await db.prepare('SELECT id FROM groups WHERE id=?').bind(group).first()) throw new HttpError(404, 'Группа не найдена')
}
export async function schedule(db: D1Database, group: string, from = '0000-01-01', to = '9999-12-31'): Promise<Schedule> {
  const [versions, dates, rows, holidays] = await db.batch([
    db.prepare('SELECT number,created FROM versions WHERE group_id=? ORDER BY number DESC LIMIT 1').bind(group),
    db.prepare('SELECT day FROM published_days WHERE group_id=? AND version=(SELECT max(number) FROM versions WHERE group_id=?) AND day BETWEEN ? AND ? ORDER BY day').bind(group, group, from, to),
    db.prepare('SELECT data FROM lessons WHERE group_id=? AND version=(SELECT max(number) FROM versions WHERE group_id=?) AND day BETWEEN ? AND ? ORDER BY day,position').bind(group, group, from, to),
    db.prepare('SELECT day FROM holidays WHERE group_id=? AND day BETWEEN ? AND ? ORDER BY day').bind(group, from, to),
  ])
  const latest = versions.results[0] as { number: number; created: string } | undefined
  const periods: Schedule['periods'] = []
  for (const { day } of dates.results as { day: string }[]) {
    const last = periods.at(-1)
    if (last && shiftDate(last.to, 1) === day) last.to = day
    else periods.push({ from: day, to: day })
  }
  const lessons = (rows.results as { data: string }[]).map(r => JSON.parse(r.data) as Lesson)
  lessons.sort((a, b) => a.date.localeCompare(b.date) || (a.pair ?? 0) - (b.pair ?? 0))
  return { group, version: latest?.number ?? 0, updated: latest?.created ?? null,
    periods, lessons, holidays: (holidays.results as { day: string }[]).map(r => r.day) }
}
interface SavedDraft { id: string; base_version: number; payload: string }
export async function getDraft(db: D1Database, owner: string, id: string) {
  const row = await db.prepare('SELECT id,base_version,payload FROM imports WHERE id=? AND owner=? AND created>?')
    .bind(id, owner, Date.now() - ttl).first<SavedDraft>()
  if (!row) throw new HttpError(404, 'Черновик не найден или устарел')
  return row
}
export async function summarizeDraft(db: D1Database, row: SavedDraft): Promise<Draft> {
  const data = JSON.parse(row.payload) as Import
  const previous = await db.prepare('SELECT data FROM lessons WHERE group_id=? AND version=? AND day BETWEEN ? AND ?')
    .bind(data.group, row.base_version, data.from, data.to).all<{ data: string }>()
  const past = new Set(previous.results.map(r => lessonKey(JSON.parse(r.data))))
  const unchanged = data.lessons.filter(l => past.has(lessonKey(l))).length
  return { ...data, id: row.id, next: row.base_version + 1,
    diff: { added: data.lessons.length - unchanged, removed: past.size - unchanged, unchanged } }
}
export async function saveDraft(db: D1Database, owner: string, value: unknown) {
  const data = validateImport(value)
  await ensureGroup(db, data.group)
  if (await db.prepare('SELECT number FROM versions WHERE group_id=? AND file_hash=?').bind(data.group, data.hash).first())
    throw new HttpError(409, 'Этот файл уже публиковали. Воспользуйтесь историей версий')
  const id = crypto.randomUUID(), payload = JSON.stringify(data)
  const row = await db.prepare('INSERT INTO imports SELECT ?, ?, ?, COALESCE(max(number),0), ?, ?, ? FROM versions WHERE group_id=? RETURNING id,base_version,payload')
    .bind(id, owner, data.group, data.hash, payload, Date.now(), data.group).first<SavedDraft>()
  return summarizeDraft(db, row!)
}
export async function publish(db: D1Database, owner: string, id: string) {
  const publishedVersion = () => db.prepare('SELECT number FROM versions JOIN imports ON imports.id=versions.draft_id WHERE imports.id=? AND imports.owner=?')
    .bind(id, owner).first<number>('number')
  const existing = await publishedVersion()
  if (existing !== null) return existing
  await getDraft(db, owner, id)
  const row = await db.prepare(`INSERT INTO versions(group_id,number,description,file_hash,draft_id)
    SELECT group_id, base_version+1,'Импорт Excel',file_hash,id FROM imports i WHERE id=? AND owner=?
      AND base_version=COALESCE((SELECT max(number) FROM versions WHERE group_id=i.group_id),0)
      AND NOT EXISTS (SELECT 1 FROM versions WHERE group_id=i.group_id AND file_hash=i.file_hash)
    RETURNING number`).bind(id, owner).first<number>('number')
  const published = row ?? await publishedVersion()
  if (published === null) throw new HttpError(409, 'Расписание уже изменилось. Создайте новый черновик')
  return published
}
export async function history(db: D1Database, group: string) {
  return (await db.prepare('SELECT number,created,description FROM versions WHERE group_id=? ORDER BY number DESC LIMIT 100').bind(group).all<Version>()).results
}
export async function rollback(db: D1Database, group: string, target: number, current: number) {
  const number = await db.prepare(`INSERT INTO versions(group_id,number,description,source)
    SELECT group_id, ?+1, 'Восстановление v' || number, number FROM versions WHERE group_id=? AND number=?
    AND number < ? AND ?=(SELECT max(number) FROM versions WHERE group_id=?) RETURNING number`)
    .bind(current, group, target, current, current, group).first<number>('number')
  if (number === null) throw new HttpError(409, 'Версия не найдена или расписание изменилось')
  return number
}
