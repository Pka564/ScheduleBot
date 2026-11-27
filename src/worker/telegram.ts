import { mainGroup, types, type Draft, type Schedule } from '../shared/model'
import { inPeriod, lessonTime, localDate, shiftDate } from '../shared/time'
import { equal, getDraft, HttpError, isAdmin, jsonBody, publish, schedule, summarizeDraft, ttl, type Env } from './core'

export const uploadLimit = 5 * 1024 * 1024
type BotMethod = 'sendMessage' | 'answerCallbackQuery' | 'getFile'
type TelegramOperation = BotMethod | 'downloadFile'
type TransportFailure = 'timeout' | 'aborted' | 'network' | 'type_error'
type TelegramFailure = TransportFailure | 'configuration' | 'transport' | 'redirect' | 'http_error' | 'invalid_response' | 'rejected'
interface Trace { id: string; apiAttempted: boolean }
const newTrace = (): Trace => ({ id: crypto.randomUUID(), apiAttempted: false })
function log(trace: Trace, event: string, fields: Record<string, string | number> = {}, level: 'info' | 'warn' = 'info') {
  // Callers pass fixed labels and status codes. Never log exceptions, requests or Telegram payloads.
  console[level]('schedulebot.telegram', { trace: trace.id, event, ...fields })
}
export class TelegramError extends Error {
  constructor(public code: number, public retryAfter: number, public reason: TelegramFailure) {
    super('Telegram API недоступен')
  }
}
const validBotToken = (token?: string) => /^\d+:[A-Za-z0-9_-]+$/.test(token?.trim() ?? '')
function failure(trace: Trace, method: TelegramOperation, reason: TelegramFailure, code: number, retryAfter = 0) {
  log(trace, 'api_failure', { method, reason, code }, 'warn')
  return new TelegramError(code, retryAfter, reason)
}
function transportFailure(error: unknown): TransportFailure | undefined {
  if (!(error instanceof Error || error instanceof DOMException)) return
  if (error.name === 'TimeoutError') return 'timeout'
  if (error.name === 'AbortError') return 'aborted'
  // Workerd also reports connection failures as plain Errors. Inspect details only for classification.
  if (error.name === 'NetworkError' ||
      /network (?:connection lost|is unreachable)|connection (?:refused|reset)|dns (?:lookup|resolution)|failed to resolve/i.test(error.message)) return 'network'
  if (error instanceof TypeError) return 'type_error'
}
async function telegramFetch(url: string, method: TelegramOperation, trace: Trace,
  init: Pick<RequestInit, 'method' | 'headers' | 'body'> = {}, timeout = 10000,
) {
  log(trace, 'api_request', { method })
  trace.apiAttempted = true
  let response: Response
  try {
    response = await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(timeout) })
  } catch (error) {
    throw failure(trace, method, transportFailure(error) ?? 'transport', 503)
  }
  // Workerd supports manual redirects. Never follow them with the bot token in the URL.
  if (response.status >= 300 && response.status < 400)
    throw failure(trace, method, 'redirect', response.status)
  return response
}
export async function telegram<T = unknown>(env: Env, method: BotMethod, payload: object, trace = newTrace()): Promise<T> {
  if (!validBotToken(env.BOT_TOKEN)) throw failure(trace, method, 'configuration', 503)
  const response = await telegramFetch(`https://api.telegram.org/bot${env.BOT_TOKEN!.trim()}/${method}`, method, trace, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  })
  let result: { ok: boolean; result: T; error_code?: number; parameters?: { retry_after?: number } } | null
  try { result = await response.json() as typeof result }
  catch (error) {
    const reason = transportFailure(error)
    throw failure(trace, method, reason ?? 'invalid_response', reason ? 503 : response.status)
  }
  if (result?.ok === false) {
    const code = typeof result.error_code === 'number' && Number.isInteger(result.error_code) &&
      result.error_code >= 400 && result.error_code <= 599 ? result.error_code : response.status
    const seconds = result.parameters?.retry_after
    const retryAfter = typeof seconds === 'number' && Number.isInteger(seconds) && seconds > 0 && seconds <= 86400 ? seconds : 0
    throw failure(trace, method, 'rejected', code, retryAfter)
  }
  if (!response.ok || result?.ok !== true || !('result' in result)) throw failure(trace, method, 'invalid_response', response.status)
  log(trace, 'api_success', { method })
  return result.result
}
export const send = (env: Env, chat: string, text: string, markup?: object, trace?: Trace) =>
  telegram(env, 'sendMessage', { chat_id: chat, text: text.slice(0, 4000), reply_markup: markup }, trace)
export const inline = (...rows: (object[])[]) => ({ inline_keyboard: rows })
const appButton = (env: Env, text: string, params?: Record<string, string>) => {
  let url: URL
  try { url = new URL(env.MINI_APP_URL) }
  catch { throw new HttpError(503, 'Адрес Telegram Mini App не настроен') }
  if (url.protocol !== 'https:' || url.username || url.password) throw new HttpError(503, 'Адрес Telegram Mini App не настроен')
  for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, v)
  return { text, web_app: { url: url.href } }
}
async function sendMenu(env: Env, chat: string, text: string, button: string, trace: Trace, params?: Record<string, string>) {
  const plain = () => send(env, chat, text + '\nКнопка Mini App временно недоступна.', undefined, trace)
  let keyboard
  try { keyboard = inline([appButton(env, button, params)]) }
  catch (error) {
    if (!(error instanceof HttpError)) throw error
    log(trace, 'menu_fallback', { reason: 'mini_app_url_invalid' }, 'warn')
    return plain()
  }
  try { return await send(env, chat, text, keyboard, trace) }
  catch (error) {
    if (!(error instanceof TelegramError) || error.reason !== 'rejected' || error.code !== 400) throw error
    log(trace, 'menu_fallback', { reason: 'keyboard_rejected' }, 'warn')
    return plain()
  }
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
  const trace = newTrace()
  try {
    await send(env, id, draftSummary(draft), inline([appButton(env, 'Предварительный просмотр', { draft: draft.id })],
      [{ text: 'Опубликовать', callback_data: `confirm:${draft.id}` }, { text: 'Отменить', callback_data: `cancel:${draft.id}` }]), trace)
  } catch (error) {
    log(trace, 'draft_notification_failed', { reason: error instanceof TelegramError ? error.reason : 'processing' }, 'warn')
  }
}
export async function cancelDraft(env: Env, owner: string, draft: string) {
  await env.DB.prepare('DELETE FROM imports WHERE id=? AND owner=? AND NOT EXISTS (SELECT 1 FROM versions WHERE draft_id=?)').bind(draft, owner, draft).run()
}
export async function workbookFile(env: Env, owner: string, id: string) {
  const file = await env.DB.prepare('SELECT file_id FROM telegram_files WHERE id=? AND owner=? AND created>?')
    .bind(id, owner, Date.now() - ttl).first<string>('file_id')
  if (!file) throw new HttpError(404, 'Файл не найден или ссылка устарела')
  const trace = newTrace()
  try {
    const result = await telegram<{ file_path: string; file_size?: number }>(env, 'getFile', { file_id: file }, trace)
    if (typeof result?.file_path !== 'string' || !/^[\w./-]+$/.test(result.file_path) ||
        result.file_path.includes('..') || (result.file_size ?? 0) > uploadLimit)
      throw new HttpError(400, 'Файл недоступен или превышает 5 МиБ')
    const upstream = await telegramFetch(`https://api.telegram.org/file/bot${env.BOT_TOKEN!.trim()}/${result.file_path}`, 'downloadFile', trace, {}, 30000)
    if (!upstream.ok || !upstream.body) throw failure(trace, 'downloadFile', 'http_error', upstream.status)
    if (Number(upstream.headers.get('content-length')) > uploadLimit) throw new HttpError(413, 'Файл слишком большой')
    let size = 0
    const body = upstream.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        size += chunk.byteLength
        if (size > uploadLimit) controller.error(new Error('XLSX limit'))
        else controller.enqueue(chunk)
      },
    }))
    log(trace, 'api_success', { method: 'downloadFile' })
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
const commands = new Set(['/start', '/id', '/admin', '/schedule', '/help', '/today', '/tomorrow'])
const validId = (id: unknown): id is number => typeof id === 'number' && Number.isSafeInteger(id) && id > 0
function privateMessage(msg: Update['message']): msg is NonNullable<Update['message']> & { from: { id: number } } {
  return msg?.chat?.type === 'private' && validId(msg.chat.id) && validId(msg.from?.id)
}
async function database<T>(trace: Trace, operation: string, work: () => Promise<T>) {
  log(trace, 'database_request', { operation })
  try { return await work() }
  catch (error) {
    if (error instanceof HttpError) throw error
    const detail = error instanceof Error ? error.message : ''
    const reason = /no such (table|column)/i.test(detail) ? 'schema' :
      /foreign key|constraint/i.test(detail) ? 'constraint' : 'unavailable'
    log(trace, 'database_failed', { operation, reason }, 'warn')
    throw error
  }
}
export async function webhook(request: Request, env: Env) {
  const trace = newTrace()
  log(trace, 'webhook_received')
  const secret = request.headers.get('X-Telegram-Bot-Api-Secret-Token') ?? ''
  if (!env.TELEGRAM_WEBHOOK_SECRET || !/^[A-Za-z0-9_-]{1,256}$/.test(env.TELEGRAM_WEBHOOK_SECRET)) {
    log(trace, 'webhook_rejected', { reason: 'webhook_secret_missing_or_invalid' }, 'warn')
    throw new HttpError(503, 'Telegram webhook не настроен')
  }
  if (!equal(secret, env.TELEGRAM_WEBHOOK_SECRET)) {
    log(trace, 'webhook_rejected', { reason: 'webhook_secret_mismatch' }, 'warn')
    throw new HttpError(403, 'Доступ запрещён')
  }
  log(trace, 'webhook_authenticated')
  let update: Update
  try {
    update = await jsonBody(request, 65536) as Update
    if (!validId(update?.update_id)) throw new HttpError(400, 'Некорректное обновление')
  } catch (error) {
    log(trace, 'webhook_rejected', { reason: 'invalid_update' }, 'warn')
    throw error
  }

  const msg = privateMessage(update.message) ? update.message : undefined
  const textCommand = typeof msg?.text === 'string' ? msg.text.trim().split(/[@\s]/)[0]?.toLowerCase() : undefined
  const command = textCommand && commands.has(textCommand) ? textCommand : undefined
  const action = update.callback_query
  const kind = action ? 'callback' : msg?.document ? 'document' : command ? 'command' : msg ? 'message' : 'ignored'
  if (kind === 'ignored') {
    log(trace, 'update_ignored')
    return Response.json({ ok: true })
  }
  if (kind !== 'message' && !validBotToken(env.BOT_TOKEN)) {
    log(trace, 'webhook_rejected', { reason: 'bot_token_missing_or_invalid' }, 'warn')
    throw new HttpError(503, 'Telegram не настроен')
  }

  const claim = await database(trace, 'claim_update', () => env.DB.prepare(
    'INSERT INTO telegram_updates (id, processed_at) VALUES (?, ?) ON CONFLICT(id) DO NOTHING',
  ).bind(update.update_id, Date.now()).run())
  if (claim.meta.changes === 0) {
    log(trace, 'update_duplicate')
    return Response.json({ ok: true, duplicate: true })
  }
  log(trace, 'update_claimed')
  log(trace, 'update_dispatch', { kind, ...(command ? { command } : {}) })
  try {
    if (action) await callback(env, action, trace)
    else if (msg) await message(env, msg, command, trace)
    log(trace, 'update_completed')
    return Response.json({ ok: true })
  } catch (error) {
    const rateLimited = kind === 'command' && error instanceof TelegramError && error.reason === 'rejected' && error.code === 429
    // Commands have a single successful outbound action. After an ambiguous failure, replaying it can duplicate a reply.
    const failedBeforeDelivery = !trace.apiAttempted && !(error instanceof HttpError && error.status < 500)
    if (rateLimited || failedBeforeDelivery) {
      await database(trace, 'release_update', () =>
        env.DB.prepare('DELETE FROM telegram_updates WHERE id=?').bind(update.update_id).run())
      const seconds = rateLimited ? Math.max(1, error.retryAfter) : 1
      log(trace, 'update_retry', { reason: rateLimited ? 'telegram_rate_limit' : 'before_delivery' }, 'warn')
      return Response.json({ ok: false }, { status: 503, headers: { 'Retry-After': String(seconds) } })
    }
    log(trace, 'update_failed', { reason: error instanceof TelegramError ? error.reason : 'processing' }, 'warn')
    return Response.json({ ok: false })
  }
}
async function callback(env: Env, action: NonNullable<Update['callback_query']>, trace: Trace) {
  if (!validId(action.from?.id) || typeof action.id !== 'string') throw new HttpError(400, 'Некорректное действие')
  const id = String(action.from.id)
  const [command, draft] = (action.data ?? '').split(':')
  const answer = (text?: string) => telegram(env, 'answerCallbackQuery', { callback_query_id: action.id, text }, trace)
  if (!isAdmin(env, id) || action.message?.chat.type !== 'private' || String(action.message.chat.id) !== id) {
    log(trace, 'admin_denied', { reason: env.ADMIN_TELEGRAM_IDS?.trim() ? 'forbidden' : 'not_configured' })
    return answer('Доступ запрещён')
  }
  if (!draft || !/^[\da-f-]{36}$/.test(draft)) return answer('Неизвестное действие')
  let reply: string | undefined
  let confirmation: Draft | undefined
  try {
    if (command === 'confirm') {
      confirmation = await database(trace, 'preview_draft', async () => summarizeDraft(env.DB, await getDraft(env.DB, id, draft)))
    } else if (command === 'publish') {
      const number = await database(trace, 'publish_draft', () => publish(env.DB, id, draft))
      reply = `Опубликована версия v${number}`
    } else if (command === 'cancel') {
      await database(trace, 'cancel_draft', () => cancelDraft(env, id, draft))
      reply = 'Черновик отменён'
    } else {
      reply = 'Неизвестное действие'
    }
  } catch (error) {
    if (!(error instanceof HttpError)) throw error
    log(trace, 'callback_rejected', { code: error.status }, 'warn')
    reply = error.message.slice(0, 190)
  }
  await answer(reply)
  if (confirmation)
    return send(env, id, `Опубликовать v${confirmation.next}? В периоде будет удалено строк: ${confirmation.diff.removed}.`,
      inline([{ text: 'Подтвердить', callback_data: `publish:${draft}` }, { text: 'Отменить', callback_data: `cancel:${draft}` }]), trace)
}
async function message(env: Env, msg: NonNullable<Update['message']> & { from: { id: number } }, command: string | undefined, trace: Trace) {
  const id = String(msg.from.id), chat = String(msg.chat.id)
  const reply = (text: string) => send(env, chat, text, undefined, trace)
  let group = mainGroup
  try {
    await database(trace, 'register_user', () => env.DB.prepare(`INSERT INTO users (id,group_id,private_chat,blocked) VALUES (?,?,1,0)
      ON CONFLICT(id) DO UPDATE SET private_chat=1,blocked=0`).bind(id, mainGroup).run())
    log(trace, 'user_registered')
    if (command === '/start' || command === '/schedule' || command === '/today' || command === '/tomorrow') {
      group = await database(trace, 'read_user_group', () =>
        env.DB.prepare('SELECT group_id FROM users WHERE id=?').bind(id).first<string>('group_id')) ?? mainGroup
    }
  } catch {
    // A registration failure should not stop the basic replies or initial admin setup.
    log(trace, 'user_registration_deferred', {}, 'warn')
  }
  if (msg.document) {
    if (!isAdmin(env, id)) {
      log(trace, 'admin_denied', { reason: env.ADMIN_TELEGRAM_IDS?.trim() ? 'forbidden' : 'not_configured' })
      return
    }
    if (!/\.xlsx$/i.test(msg.document.file_name ?? '') || (msg.document.file_size ?? 0) > uploadLimit)
      return reply('Отправьте файл .xlsx размером до 5 МиБ')
    const file = crypto.randomUUID()
    await database(trace, 'stage_file', () => env.DB.prepare('INSERT INTO telegram_files VALUES (?,?,?,?)')
      .bind(file, id, msg.document!.file_id, Date.now()).run())
    return sendMenu(env, chat, 'Файл получен. Откройте импорт, чтобы проверить расписание перед публикацией.',
      'Разобрать Excel', trace, { file })
  }
  if (command === '/id') return reply(`Ваш Telegram ID: ${id}`)
  if (command === '/today' || command === '/tomorrow') {
    const date = shiftDate(localDate(), command === '/tomorrow' ? 1 : 0)
    const data = await database(trace, 'read_schedule', () => schedule(env.DB, group, date, date))
    return reply(dayText(data, date))
  }
  if (command === '/admin') {
    if (!isAdmin(env, id)) {
      log(trace, 'admin_denied', { reason: env.ADMIN_TELEGRAM_IDS?.trim() ? 'forbidden' : 'not_configured' })
      return reply('Доступ запрещён')
    }
    return sendMenu(env, chat, 'Отправьте XLSX сообщением или откройте панель управления.', 'Управление', trace, { admin: '1' })
  }
  if (command === '/start' || command === '/schedule' || command === '/help')
    return sendMenu(env, chat, command === '/help' ?
      '/schedule — открыть расписание\n/today — сегодня\n/tomorrow — завтра\n/id — ваш Telegram ID\nНастройки подписки доступны в Mini App.' :
      `Расписание УрТИСИ СибГУТИ · ${group}`, 'Расписание', trace)
}
