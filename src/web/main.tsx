import { lazy, Suspense, useCallback, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { mainGroup, preferences, type Preference, type Schedule, type Settings } from '../shared/model'
import { inPeriod, localDate, zone } from '../shared/time'
import { api, store, stored, telegramApp } from './client'
import { Icon } from './icons'
import { Calendar, Daily, periodLabel, Search, StatusCard } from './schedule'
import './style.css'

const Admin = lazy(() => import('./admin'))
const params = new URLSearchParams(location.search)
type Tab = 'schedule' | 'search' | 'settings' | 'admin'
type Theme = 'auto' | 'light' | 'dark'
type User = Settings & { admin: boolean; private_chat: number }
type Snapshot = { data: Schedule; synced: number }
const blank = (group: string): Schedule => ({ group, version: 0, updated: null, periods: [], lessons: [], holidays: [] })
const cache = (group: string) => 'schedulebot:schedule:' + group
const chooseDate = (data: Schedule, today: string) =>
  inPeriod(today, data.periods) ? today : data.lessons.find(l => l.date >= today)?.date ?? data.periods.at(-1)?.to ?? today
const initialGroup = stored<string>('schedulebot:group') ?? mainGroup
function App() {
  const initial = stored<Snapshot>(cache(initialGroup))
  const [group, setGroup] = useState(initialGroup)
  const [groups, setGroups] = useState<string[]>(stored<string[]>('schedulebot:groups') ?? [mainGroup])
  const [snapshot, setSnapshot] = useState<Snapshot | undefined>(initial)
  const [now, setNow] = useState(Date.now)
  const [date, setDate] = useState(initial ? chooseDate(initial.data, localDate()) : localDate)
  const [manuallySelected, setManuallySelected] = useState(false)
  const [tab, setTab] = useState<Tab>(params.has('file') || params.has('draft') || params.has('admin') ? 'admin' : 'schedule')
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('')
  const [theme, setTheme] = useState<Theme>(() => stored<Theme>('schedulebot:theme') ?? 'auto')
  const [system, setSystem] = useState<'light' | 'dark'>(telegramApp?.initData ? telegramApp.colorScheme : 'dark')
  const [error, setError] = useState('')
  const [userError, setUserError] = useState('')
  const [user, setUser] = useState<User>()
  const [saving, setSaving] = useState(false)
  const [refreshID, setRefreshID] = useState(0)
  const refresh = useCallback(() => setRefreshID(id => id + 1), [])
  const today = localDate(now)
  const data = snapshot?.data ?? blank(group)
  const onGroup = useCallback((next: string) => {
    setGroup(next)
    store('schedulebot:group', next)
  }, [])
  useEffect(() => {
    const restore = () => {
      if (document.visibilityState === 'visible') { setNow(Date.now()); refresh() }
    }
    const timer = setInterval(() => setNow(Date.now()), 1000)
    document.addEventListener('visibilitychange', restore)
    window.addEventListener('online', refresh)
    const applyTelegram = () => {
      if (!telegramApp?.initData) return
      setSystem(telegramApp.colorScheme)
      const root = document.documentElement
      for (const direction of ['top', 'right', 'bottom', 'left'] as const) {
        const inset = Math.max(telegramApp.safeAreaInset?.[direction] ?? 0, telegramApp.contentSafeAreaInset?.[direction] ?? 0)
        root.style.setProperty('--tg-' + direction, inset + 'px')
      }
    }
    telegramApp?.ready(); telegramApp?.expand()
    for (const name of ['themeChanged', 'safeAreaChanged', 'contentSafeAreaChanged']) telegramApp?.onEvent(name, applyTelegram)
    applyTelegram()
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', restore)
      window.removeEventListener('online', refresh)
      for (const name of ['themeChanged', 'safeAreaChanged', 'contentSafeAreaChanged']) telegramApp?.offEvent(name, applyTelegram)
    }
  }, [refresh])
  useEffect(() => {
    const current = theme === 'auto' ? system : theme
    document.documentElement.dataset.theme = current
    store('schedulebot:theme', theme)
    const color = current === 'dark' ? '#000000' : '#f4f6fa'
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', color)
    try { telegramApp?.setHeaderColor(color); telegramApp?.setBackgroundColor(color) } catch { /* Old Telegram clients. */ }
  }, [theme, system])
  useEffect(() => {
    if (!telegramApp?.initData) return
    let cancelled = false
    api<User>('/settings', undefined, 'GET', true).then(result => {
      if (!cancelled) {
        setUser(result)
        if (!params.has('admin') && !params.has('draft') && !params.has('file')) onGroup(result.group)
      }
    }).catch(err => { if (!cancelled) setUserError(err.message) })
    return () => { cancelled = true }
  }, [onGroup])
  useEffect(() => {
    let cancelled = false
    api<string[]>('/groups').then(next => {
      if (!cancelled) { setGroups(next); store('schedulebot:groups', next) }
    }).catch(() => undefined)
    return () => { cancelled = true }
  }, [refreshID])
  useEffect(() => {
    let cancelled = false
    setError('')
    setSnapshot(previous => previous?.data.group === group ? previous : stored<Snapshot>(cache(group)))
    api<Schedule>(`/groups/${encodeURIComponent(group)}/schedule`).then(data => {
      if (cancelled) return
      const next = { data, synced: Date.now() }
      setSnapshot(next); store(cache(group), next)
    }).catch(err => { if (!cancelled) setError(err.message) })
    return () => { cancelled = true }
  }, [group, refreshID])
  useEffect(() => { if (!manuallySelected && snapshot) setDate(chooseDate(snapshot.data, today)) }, [snapshot, today, manuallySelected])
  const navigate = (next: string) => { setTab('schedule'); setManuallySelected(true); setDate(next) }
  const save = async (settings: Settings) => {
    setSaving(true); setUserError('')
    try {
      const next = await api<User>('/settings', settings, 'PUT', true)
      setUser(next); onGroup(next.group)
    } catch (err) { setUserError((err as Error).message) }
    finally { setSaving(false) }
  }
  const latest = data.periods.at(-1)
  return <div className="shell">
    <header className="app-header">
      <div className="identity"><span className="brand-icon"><Icon name="calendar" /></span><span>ScheduleBot</span><span className="institution">УрТИСИ СибГУТИ</span></div>
      <div className="header-actions">
        <button className="icon-button" aria-label="Переключить тему" title="Переключить тему" onClick={() => setTheme((theme === 'auto' ? system : theme) === 'dark' ? 'light' : 'dark')}>
          <Icon name={(theme === 'auto' ? system : theme) === 'dark' ? 'sun' : 'moon'} />
        </button>
        <button className="icon-button" aria-label="Настройки" title="Настройки" aria-pressed={tab === 'settings'} onClick={() => setTab(tab === 'settings' ? 'schedule' : 'settings')}><Icon name="settings" /></button>
      </div>
    </header>
    <main>
      <div className="intro">
        <h1>Расписание<span>.</span></h1>
        <div className="intro-meta">
          {groups.length > 1 ? <select className="group-picker" aria-label="Группа" value={group} onChange={e => { onGroup(e.target.value); setManuallySelected(false) }}>
            {[...new Set([...groups, group])].map(g => <option key={g}>{g}</option>)}</select> : <strong>{group}</strong>}
          {latest && <span>{periodLabel(latest.from, latest.to)}</span>}
          {data.version > 0 && <span className="version">v{data.version}</span>}
        </div>
      </div>
      <nav className="tabs" aria-label="Разделы приложения">
        <button aria-current={tab === 'schedule' ? 'page' : undefined} onClick={() => setTab('schedule')}><Icon name="calendar" /> Сегодня</button>
        <button aria-current={tab === 'search' ? 'page' : undefined} onClick={() => setTab('search')}><Icon name="search" /> Поиск</button>
      </nav>
      {error && <div className="message error connection" role="status"><span>{snapshot ? 'Нет связи с сервером. Показана сохранённая копия.' : error}</span><button className="icon-button" aria-label="Повторить загрузку" onClick={refresh}><Icon name="refresh" /></button></div>}
      {tab === 'schedule' && (snapshot ? <div className="schedule-grid">
        <StatusCard data={data} now={now} today={today} onDate={navigate} />
        <Calendar data={data} date={date} today={today} onDate={navigate} />
        <Daily data={data} date={date} today={today} now={now} />
      </div> : <div className="empty loading" role="status"><Icon name={error ? 'calendar' : 'clock'} /><h2>{error ? 'Расписание недоступно' : 'Загружаем расписание…'}</h2></div>)}
      {tab === 'search' && (snapshot ? <Search data={data} query={query} filter={filter} onQuery={setQuery} onFilter={setFilter} onDate={navigate} /> :
        <div className="empty" role="status">{error ? 'Расписание недоступно' : 'Загружаем расписание…'}</div>)}
      {tab === 'settings' && <section className="settings-content">
        <h2>Настройки</h2>
        <div className="panel"><label className="field">Тема<select value={theme} onChange={e => setTheme(e.target.value as Theme)}>
          <option value="auto">Как в Telegram</option><option value="dark">Тёмная</option><option value="light">Светлая</option>
        </select></label></div>
        <div className="panel"><h3><Icon name="bell" /> Уведомления</h3>
          {!telegramApp?.initData && <p className="subtext">Откройте Mini App в Telegram, чтобы настроить уведомления.</p>}
          {userError && <p className="message error" role="alert">{userError}</p>}
          {user && <>
            {!user.private_chat && <p className="subtext">Отправьте /start боту в личном чате, чтобы получать сообщения.</p>}
            <label className="field">Группа для уведомлений<select value={user.group} disabled={saving} onChange={e => void save({ ...user, group: e.target.value })}>
              {[...new Set([...groups, user.group])].map(g => <option key={g}>{g}</option>)}
            </select></label>
            {(Object.keys(preferences) as Preference[]).map(key => <label className="toggle" key={key}>
              <span>{preferences[key]}</span><input type="checkbox" checked={user[key]} disabled={saving} onChange={e => void save({ ...user, [key]: e.target.checked })} />
            </label>)}
          </>}
        </div>
        {user?.admin && <button className="secondary" onClick={() => setTab('admin')}>Управление расписанием <Icon name="arrow" /></button>}
      </section>}
      {tab === 'admin' && (user?.admin ? <Suspense fallback={<p className="subtext">Загружаем управление…</p>}>
        <Admin group={group} groups={groups} onGroup={onGroup} onChange={refresh} holidays={data.holidays} />
      </Suspense> : <p className="message">{user && !user.admin ? 'Доступ только для администратора' : userError || (telegramApp?.initData ? 'Проверяем доступ…' : 'Откройте приложение через команду /admin в Telegram')}</p>)}
    </main>
    <footer><span><Icon name="clock" /> Время Екатеринбурга</span>{snapshot && <span>Синхронизация в {new Date(snapshot.synced).toLocaleTimeString('ru', { timeZone: zone, hour: '2-digit', minute: '2-digit' })}</span>}</footer>
  </div>
}
createRoot(document.getElementById('root')!).render(<App />)

if (import.meta.env.PROD && 'serviceWorker' in navigator)
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register(import.meta.env.BASE_URL + 'offline.js').catch(() => undefined)
  })
