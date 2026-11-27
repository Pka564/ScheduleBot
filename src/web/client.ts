export interface TelegramApp {
  initData: string
  colorScheme: 'light' | 'dark'
  viewportStableHeight: number
  safeAreaInset?: { top: number; bottom: number; left: number; right: number }
  contentSafeAreaInset?: { top: number; bottom: number; left: number; right: number }
  ready(): void
  expand(): void
  onEvent(event: string, callback: () => void): void
  offEvent(event: string, callback: () => void): void
  setHeaderColor(color: string): void
  setBackgroundColor(color: string): void
}
export const telegramApp = (window as Window & { Telegram?: { WebApp?: TelegramApp } }).Telegram?.WebApp
const base = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '')
export async function api<T>(path: string, payload?: unknown, method = payload === undefined ? 'GET' : 'POST', auth = false): Promise<T> {
  const response = await request(path, method, payload, auth)
  return response.json() as Promise<T>
}
async function request(path: string, method: string, payload?: unknown, auth?: boolean) {
  const headers = new Headers()
  if (auth && telegramApp?.initData) headers.set('Authorization', 'tma ' + telegramApp.initData)
  if (payload !== undefined) headers.set('Content-Type', 'application/json')
  let response: Response
  try {
    response = await fetch(base + '/api' + path, { method, headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(15000) })
  } catch { throw new Error('Нет связи с сервером') }
  if (!response.ok) {
    const message = await response.json().then(data => (data as { error?: string }).error).catch(() => null)
    throw new Error(message ?? 'Сервер временно недоступен')
  }
  return response
}
export async function downloadWorkbook(id: string) {
  return new Uint8Array(await (await request('/admin/file/' + encodeURIComponent(id), 'GET', undefined, true)).arrayBuffer())
}
export function stored<T>(key: string): T | undefined {
  try { return JSON.parse(localStorage.getItem(key) ?? 'null') ?? undefined } catch { return undefined }
}
export function store(key: string, data: unknown) {
  try { localStorage.setItem(key, JSON.stringify(data)) } catch { /* Browser storage may be disabled. */ }
}
export const dateText = (date: string, options: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat('ru', { timeZone: 'UTC', ...options }).format(new Date(date))
