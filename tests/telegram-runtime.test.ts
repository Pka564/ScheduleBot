import { createHmac } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { build } from 'esbuild'
import { Miniflare, type WorkerdStructuredLog } from 'miniflare'
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { unstable_readConfig, unstable_splitSqlQuery } from 'wrangler'

const token = '123:runtime-test-token'
const secret = 'runtime-test-webhook-secret'
const workbook = Buffer.from([0x50, 0x4b, 3, 4, 9])
const base = 'https://worker.test'
const calls: { path: string; method?: string; type?: string; json?: unknown }[] = []
const logs: string[] = []
let runtime: Miniflare
let db: Awaited<ReturnType<Miniflare['getD1Database']>>
let behavior: 'success' | 'api_redirect' | 'file_redirect' | 'network' | 'timeout' | 'rejected' = 'success'

beforeAll(async () => {
  const config = unstable_readConfig({ config: 'wrangler.toml' })
  const bundle = await build({ entryPoints: [config.main!], bundle: true, write: false, format: 'esm', target: 'es2023' })
  runtime = new Miniflare({
    enableDevRegistry: false,
    unsafeTriggerHandlers: true,
    handleStructuredLogs: (entry: WorkerdStructuredLog) => logs.push(entry.message),
    workers: [{
      config: {
        name: 'schedulebot-runtime',
        compatibilityDate: config.compatibility_date!,
        compatibilityFlags: config.compatibility_flags,
        manifest: { mainModule: 'index.js', modules: { 'index.js': { type: 'esm', contents: bundle.outputFiles[0].text } } },
        env: {
          DB: { type: 'd1', name: 'schedulebot-runtime', id: 'schedulebot-runtime' },
          BOT_TOKEN: { type: 'text', value: token },
          TELEGRAM_WEBHOOK_SECRET: { type: 'text', value: secret },
          ADMIN_TELEGRAM_IDS: { type: 'text', value: '101' },
          MINI_APP_URL: { type: 'text', value: 'https://example.test/ScheduleBot/' },
        },
      },
      // The Worker still calls workerd's native fetch. This local service replaces only the remote peer.
      dev: { outboundService: { type: 'node-handler', async handler(req: IncomingMessage, res: ServerResponse) {
        const path = new URL(req.url!, 'https://api.telegram.org').pathname
        const chunks = []
        for await (const chunk of req) chunks.push(chunk)
        const body = Buffer.concat(chunks).toString()
        calls.push({ path, method: req.method, type: req.headers['content-type'], json: body ? JSON.parse(body) : undefined })
        const downloading = path === `/file/bot${token}/documents/schedule.xlsx`
        if (behavior === 'api_redirect' || downloading && behavior === 'file_redirect') {
          res.writeHead(307, { Location: 'https://redirect.invalid/private-location' }).end()
          return
        }
        if (behavior === 'network') { res.destroy(); return }
        if (behavior === 'timeout') {
          const timer = setTimeout(() => res.end('late response'), 15000)
          res.once('close', () => clearTimeout(timer))
          return
        }
        if (downloading) {
          res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': workbook.length }).end(workbook)
          return
        }
        if (behavior === 'rejected') {
          res.writeHead(403, { 'Content-Type': 'application/json' }).end(JSON.stringify({
            ok: false, error_code: 403, description: 'private-upstream-detail',
          }))
          return
        }
        const result = path.endsWith('/getFile') ? { file_path: 'documents/schedule.xlsx', file_size: workbook.length } : true
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, result }))
      } } },
    }],
  })
  db = await runtime.getD1Database('DB')
  for (const name of (await readdir('migrations')).sort()) {
    const sql = await readFile('migrations/' + name, 'utf8')
    await db.batch(unstable_splitSqlQuery(sql).map(statement => db.prepare(statement)))
  }
}, 20000)
afterAll(async () => { await runtime?.dispose() })
beforeEach(() => { calls.length = 0; logs.length = 0; behavior = 'success' })

const update = (updateId: number, payload: object) => runtime.dispatchFetch(base + '/api/telegram', {
  method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': secret },
  body: JSON.stringify({ update_id: updateId, ...payload }),
})
const command = (updateId: number, text: string) =>
  update(updateId, { message: { from: { id: 101 }, chat: { id: 101, type: 'private' }, text } })
async function download() {
  const id = 'decba111-1111-1111-1111-111111111111'
  await db.prepare('INSERT OR IGNORE INTO telegram_files VALUES (?,?,?,?)').bind(id, '101', 'runtime-file-id', Date.now()).run()
  const fields = { auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: 101 }) }
  const key = createHmac('sha256', 'WebAppData').update(token).digest()
  const hash = createHmac('sha256', key).update(Object.entries(fields).map(x => x.join('=')).join('\n')).digest('hex')
  const data = new URLSearchParams({ ...fields, hash })
  return runtime.dispatchFetch(base + '/api/admin/file/' + id, { headers: { Authorization: 'tma ' + data } })
}
async function expectFailure(method: string, reason: string) {
  await vi.waitFor(() => expect(logs.some(line => line.includes('api_failure') && line.includes(method) && line.includes(reason))).toBe(true))
  const diagnostic = logs.join('\n')
  for (const sensitive of [token, secret, 'private-location', 'private-upstream-detail', 'runtime-file-id'])
    expect(diagnostic).not.toContain(sensitive)
}

it('отправляет ответы /start, /id и /admin через настоящий fetch workerd', async () => {
  for (const [id, text] of [[1, '/start'], [2, '/id'], [3, '/admin']] as const)
    expect(await (await command(id, text)).json()).toEqual({ ok: true })
  expect(calls.map(({ path, method, type }) => [path, method, type])).toEqual(
    Array.from({ length: 3 }, () => [`/bot${token}/sendMessage`, 'POST', 'application/json']))
  expect(calls[1].json).toEqual({ chat_id: '101', text: 'Ваш Telegram ID: 101' })
  expect(await db.prepare('SELECT private_chat FROM users WHERE id=?').bind('101').first('private_chat')).toBe(1)
})

it('отправляет answerCallbackQuery из обработчика webhook', async () => {
  expect(await (await update(4, { callback_query: {
    id: 'runtime-callback-id', from: { id: 101 }, message: { chat: { id: 101, type: 'private' } }, data: 'invalid',
  } })).json()).toEqual({ ok: true })
  expect(calls).toEqual([expect.objectContaining({ path: `/bot${token}/answerCallbackQuery`, method: 'POST',
    json: { callback_query_id: 'runtime-callback-id', text: 'Неизвестное действие' } })])
})

it('получает getFile, затем загружает XLSX без изменения байтов', async () => {
  const response = await download()
  expect(response.status).toBe(200)
  expect(Buffer.from(await response.arrayBuffer())).toEqual(workbook)
  expect(calls.map(c => [c.path, c.method])).toEqual([
    [`/bot${token}/getFile`, 'POST'], [`/file/bot${token}/documents/schedule.xlsx`, 'GET'],
  ])
})

it('отправляет уведомление из scheduled handler через тот же транспорт', async () => {
  const now = Date.now()
  await db.prepare('INSERT OR IGNORE INTO users(id,private_chat,morning) VALUES (?,1,1)').bind('102').run()
  await db.prepare(`INSERT INTO notification_jobs(user_id,event,group_id,message,due,expires)
    VALUES ('102','morning:runtime','П-61БС','Тест уведомления',?,?)`).bind(now, now + 60000).run()
  expect((await runtime.dispatchFetch(base + '/cdn-cgi/local/scheduled?time=' + now)).status).toBe(200)
  expect(calls).toEqual([expect.objectContaining({
    path: `/bot${token}/sendMessage`, json: { chat_id: '102', text: 'Тест уведомления' },
  })])
})

it('не следует перенаправлению sendMessage и не повторяет доставку', async () => {
  behavior = 'api_redirect'
  expect(await (await command(5, '/id')).json()).toEqual({ ok: false })
  expect(await (await command(5, '/id')).json()).toEqual({ ok: true, duplicate: true })
  expect(calls.map(c => c.path)).toEqual([`/bot${token}/sendMessage`])
  await expectFailure('sendMessage', 'redirect')
})

it('не следует перенаправлению при загрузке файла', async () => {
  behavior = 'file_redirect'
  expect((await download()).status).toBe(502)
  expect(calls.map(c => c.path)).toEqual([`/bot${token}/getFile`, `/file/bot${token}/documents/schedule.xlsx`])
  await expectFailure('downloadFile', 'redirect')
})

it.each([['network', 6], ['rejected', 7], ['timeout', 8]] as const)(
  'различает сбой %s по результату настоящего запроса workerd',
  async (mode, id) => {
    behavior = mode
    expect(await (await command(id, '/id')).json()).toEqual({ ok: false })
    expect(calls).toHaveLength(1)
    await expectFailure('sendMessage', mode)
  },
  15000,
)
