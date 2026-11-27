import { defaultSettings, mainGroup, types, type Draft, type Schedule } from '../shared/model'
import { inPeriod, lessonTime, localDate, shiftDate } from '../shared/time'
import { equal, getDraft, HttpError, isAdmin, jsonBody, publish, schedule, summarizeDraft, ttl, type Env } from './core'

export const uploadLimit = 5 * 1024 * 1024
export class TelegramError extends Error {
  constructor(public code: number, public retryAfter: number) { super('Telegram API недоступен') }
}
export async function telegram<T = unknown>(env: Env, method: string, payload: object): Promise<T> {
  if (!env.BOT_TOKEN) throw new HttpError(503, 'Telegram не настроен')
  try {
    const response = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), redirect: 'error',
    })
    const result = await response.json() as { ok: boolean; result: T; error_code?: number; parameters?: { retry_after?: number } }
    if (!result.ok) throw new TelegramError(result.error_code ?? response.status, result.parameters?.retry_after ?? 0)
    return result.result
  } catch (error) {
    if (error instanceof TelegramError) throw error
    throw new TelegramError(503, 0)
  }
}
export const send = (env: Env, chat: string, text: string, markup?: object) =>
  telegram(env, 'sendMessage', { chat_id: chat, text: text.slice(0, 4000), reply_markup: markup })
export const inline = (...rows: (object[])[]) => ({ inline_keyboard: rows })
const appButton = (env: Env, text: string, params?: Record<string, string>) => {
  const url = new URL(env.MINI_APP_URL)
  for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, v)
  return { text, web_app: { url: url.href } }
}
export function dayText(data: Schedule, date: string) {
  const label = new Intl.DateTimeFormat('ru', { timeZone: 'UTC', dateStyle: 'full' }).format(new Date(date))
  const heading = `${data.group} · ${label}`
  if (!inPeriod(date, data.periods)) return `${heading}\nРасписание пока не опубликовано`
  const lines = data.lessons.filter(l => l.date === date).map(l => {
    const { start, end } = lessonTime(l, data.holidays)
    return [`${l.pair ? l.pair + '. ' : ''}${l.title}`, [start && (end ? `${start}–${end}` : `с ${start}`), types[l.type], l.room, l.building].filter(Boolean).join(' · '),
      [l.teacher, l.notes].filter(Boolean).join(' · ')].filter(Boolean).join('\n')
  })
  return `${heading}\n\n${lines.length ? lines.join('\n\n') : 'Занятий нет'}`
}
export function draftSummary(draft: Draft) {
  return `${draft.group} · ${draft.from}–${draft.to}\nВерсия v${draft.next}\nУчебных дней: ${new Set(draft.lessons.filter(l => l.pair !== null).map(l => l.date)).size}\nЗанятий и мероприятий: ${draft.lessons.length}\nЭкзаменов: ${draft.lessons.filter(l => l.type === 'exam').length}\nЗачётов: ${draft.lessons.filter(l => l.type === 'credit').length}\nПредупреждений: ${draft.warnings.length}\nДобавлено: ${draft.diff.added} · Удалено: ${draft.diff.removed} · Без изменений: ${draft.diff.unchanged}`
}
export async function postDraft(env: Env, id: string, draft: Draft) {
  await send(env, id, draftSummary(draft), inline([appButton(env, 'Предварительный просмотр', { draft: draft.id })],
    [{ text: 'Опубликовать', callback_data: `confirm:${draft.id}` }, { text: 'Отменить', callback_data: `cancel:${draft.id}` }]))
}
export async function cancelDraft(env: Env, owner: string, draft: string) {
  await env.DB.prepare('DELETE FROM imports WHERE id=? AND owner=? AND NOT EXISTS (SELECT 1 FROM versions WHERE draft_id=?)').bind(draft, owner, draft).run()
}
export async function workbookFile(env: Env, owner: string, id: string) {
  const file = await env.DB.prepare('SELECT file_id FROM telegram_files WHERE id=? AND owner=? AND created>?')
    .bind(id, owner, Date.now() - ttl).first<string>('file_id')
  if (!file) throw new HttpError(404, 'Файл не найден или ссылка устарела')
  try {
    const result = await telegram<{ file_path: string; file_size?: number }>(env, 'getFile', { file_id: file })
    if (!/^[\w./-]+$/.test(result.file_path) || result.file_path.includes('..') || (result.file_size ?? 0) > uploadLimit)
      throw new HttpError(400, 'Файл недоступен или превышает 5 МиБ')
    const upstream = await fetch(`https://api.telegram.org/file/bot${env.BOT_TOKEN}/${result.file_path}`, { redirect: 'error' })
    if (!upstream.ok || !upstream.body) throw new Error()
    if (Number(upstream.headers.get('content-length')) > uploadLimit) throw new HttpError(413, 'Файл слишком большой')
    let size = 0
    const body = upstream.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        size += chunk.byteLength
        if (size > uploadLimit) controller.error(new Error('XLSX limit'))
        else controller.enqueue(chunk)
      },
    }))
    return new Response(body, { headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' } })
  } catch (err) {
    if (err instanceof HttpError) throw err
    throw new HttpError(502, 'Telegram не предоставил файл. Отправьте его боту повторно')
  }
}

interface Update {
  update_id: number
  message?: { from?: { id: number }; chat: { id: number; type: string }; text?: string;
    document?: { file_id: string; file_name?: string; file_size?: number } }
  callback_query?: { id: string; from: { id: number }; data?: string; message?: { message_id: number; chat: { id: number; type: string } } }
}
export async function webhook(request: Request, env: Env) {
  const secret = request.headers.get('X-Telegram-Bot-Api-Secret-Token') ?? ''
  if (!env.TELEGRAM_WEBHOOK_SECRET || !equal(secret, env.TELEGRAM_WEBHOOK_SECRET)) throw new HttpError(403, 'Доступ запрещён')
  const update = await jsonBody(request, 65536) as Update
  if (!Number.isSafeInteger(update?.update_id)) throw new HttpError(400, 'Некорректное обновление')
  const claim = await env.DB.prepare('INSERT OR IGNORE INTO telegram_updates VALUES (?,?) RETURNING id').bind(update.update_id, Date.now()).first()
  if (!claim) return Response.json({ ok: true, duplicate: true })
  try {
    if (update.callback_query) await callback(env, update.callback_query)
    else if (update.message?.from && update.message.chat.type === 'private') await message(env, update.message)
  } catch {
    // Telegram may have accepted the outgoing message even if the response was lost.
    // Keep the claim so delivery retries cannot cause duplicate bot actions.
  }
  return Response.json({ ok: true })
}
async function callback(env: Env, action: NonNullable<Update['callback_query']>) {
  const id = String(action.from.id)
  const [command, draft] = (action.data ?? '').split(':')
  const answer = (text?: string) => telegram(env, 'answerCallbackQuery', { callback_query_id: action.id, text })
  if (!isAdmin(env, id) || action.message?.chat.type !== 'private' || String(action.message.chat.id) !== id) return answer('Доступ запрещён')
  if (!draft || !/^[\da-f-]{36}$/.test(draft)) return answer('Неизвестное действие')
  try {
    if (command === 'confirm') {
      const preview = await summarizeDraft(env.DB, await getDraft(env.DB, id, draft))
      await answer()
      return send(env, id, `Опубликовать v${preview.next}? В периоде будет удалено строк: ${preview.diff.removed}.`,
        inline([{ text: 'Подтвердить', callback_data: `publish:${draft}` }, { text: 'Отменить', callback_data: `cancel:${draft}` }]))
    }
    if (command === 'publish') {
      const number = await publish(env.DB, id, draft)
      return answer(`Опубликована версия v${number}`)
    }
    if (command === 'cancel') {
      await cancelDraft(env, id, draft)
      return answer('Черновик отменён')
    }
    return answer('Неизвестное действие')
  } catch (err) {
    return answer(err instanceof HttpError ? err.message.slice(0, 190) : 'Операцию не удалось выполнить')
  }
}
async function message(env: Env, msg: NonNullable<Update['message']>) {
  const id = String(msg.from!.id)
  const user = await env.DB.prepare(`INSERT INTO users (id,private_chat) VALUES (?,1)
    ON CONFLICT(id) DO UPDATE SET private_chat=1,blocked=0 RETURNING group_id`).bind(id).first<string>('group_id')
  if (msg.document) {
    if (!isAdmin(env, id)) return
    if (!/\.xlsx$/i.test(msg.document.file_name ?? '') || (msg.document.file_size ?? 0) > uploadLimit)
      return send(env, id, 'Отправьте файл .xlsx размером до 5 МиБ')
    const file = crypto.randomUUID()
    await env.DB.prepare('INSERT INTO telegram_files VALUES (?,?,?,?)').bind(file, id, msg.document.file_id, Date.now()).run()
    return send(env, id, 'Файл получен. Откройте импорт, чтобы проверить расписание перед публикацией.',
      inline([appButton(env, 'Разобрать Excel', { file })]))
  }
  const command = msg.text?.trim().split(/[@\s]/)[0]
  if (command === '/id') return send(env, id, `Ваш Telegram ID: ${id}`)
  if (command === '/today' || command === '/tomorrow') {
    const date = shiftDate(localDate(), command === '/tomorrow' ? 1 : 0)
    return send(env, id, dayText(await schedule(env.DB, user ?? mainGroup, date, date), date))
  }
  if (command === '/admin') {
    if (!isAdmin(env, id)) return send(env, id, 'Доступ запрещён')
    return send(env, id, 'Отправьте XLSX сообщением или откройте панель управления.', inline([appButton(env, 'Управление', { admin: '1' })]))
  }
  if (command === '/start' || command === '/schedule' || command === '/help')
    return send(env, id, command === '/help' ?
      '/schedule — открыть расписание\n/today — сегодня\n/tomorrow — завтра\n/id — ваш Telegram ID\nНастройки подписки доступны в Mini App.' :
      `Расписание УрТИСИ СибГУТИ · ${user ?? defaultSettings.group}`, inline([appButton(env, 'Расписание')]))
}
