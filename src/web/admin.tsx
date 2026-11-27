import { useCallback, useEffect, useState } from 'react'
import { preferences, type Draft, type Import, type Preference, type Version } from '../shared/model'
import { api, dateText, downloadWorkbook } from './client'
import { LessonList, periodLabel } from './schedule'

interface Dashboard { versions: Version[]; users: number; subscribers: number; disabled: Preference[] }
async function parse(bytes: Uint8Array<ArrayBuffer>, group: string, year?: number) {
  const worker = new Worker(new URL('./excel.worker.ts', import.meta.url), { type: 'module' })
  try {
    return await new Promise<Import>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Не удалось разобрать файл за 30 секунд')), 30000)
      worker.onmessage = ({ data }) => {
        clearTimeout(timeout)
        if (data.error) reject(new Error(data.error))
        else resolve(data.result as Import)
      }
      worker.onerror = () => { clearTimeout(timeout); reject(new Error('Браузер не смог запустить обработку XLSX')) }
      worker.postMessage({ bytes: bytes.buffer, group, year }, [bytes.buffer])
    })
  } finally { worker.terminate() }
}

export default function Admin({ group, groups, onGroup, onChange, holidays }: {
  group: string; groups: string[]; onGroup: (s: string) => void; onChange: () => void; holidays: string[]
}) {
  const params = new URLSearchParams(location.search)
  const [fileId, setFileId] = useState(params.get('file'))
  const [draftId, setDraftId] = useState(params.get('draft'))
  const [file, setFile] = useState<File>()
  const [year, setYear] = useState('')
  const [draft, setDraft] = useState<Draft>()
  const [dashboard, setDashboard] = useState<Dashboard>()
  const [date, setDate] = useState('')
  const [newGroup, setNewGroup] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState('')
  const [message, setMessage] = useState('')
  const [confirm, setConfirm] = useState<number | 'publish'>()
  const dashboardPath = `/admin/dashboard?group=${encodeURIComponent(group)}`
  const refresh = useCallback(async () => setDashboard(await api<Dashboard>(dashboardPath, undefined, 'GET', true)), [dashboardPath])
  useEffect(() => {
    let cancelled = false
    setDashboard(undefined)
    api<Dashboard>(dashboardPath, undefined, 'GET', true).then(data => { if (!cancelled) setDashboard(data) })
      .catch(err => { if (!cancelled) setProblem(err.message) })
    return () => { cancelled = true }
  }, [dashboardPath])
  useEffect(() => {
    if (!draftId) return
    let cancelled = false
    api<Draft>(`/admin/draft/${encodeURIComponent(draftId)}`, undefined, 'GET', true)
      .then(data => { if (!cancelled) { setDraft(data); onGroup(data.group) } })
      .catch(err => { if (!cancelled) setProblem(err.message) })
    return () => { cancelled = true }
  }, [draftId, onGroup])
  const action = async (work: () => Promise<void>) => {
    setBusy(true); setProblem(''); setMessage('')
    try { await work() } catch (err) { setProblem((err as Error).message) }
    finally { setBusy(false) }
  }
  const clearDraft = () => {
    setDraft(undefined); setDraftId(null); setConfirm(undefined); setFileId(null)
    history.replaceState(null, '', location.pathname + '?admin=1')
  }
  return <section className="settings-content">
    <div className="section-header"><h2>Управление расписанием</h2>
      <label className="field inline-field">Группа<select value={group} disabled={busy || Boolean(draft)} onChange={e => onGroup(e.target.value)}>
        {[...new Set([...groups, group])].map(g => <option key={g}>{g}</option>)}
      </select></label>
    </div>
    {problem && <p role="alert" className="message error">{problem}</p>}{message && <p role="status" className="message">{message}</p>}
    <div className="panel">
      <h3>Импорт Excel</h3>
      {!draft && <form onSubmit={e => {
        e.preventDefault()
        void action(async () => {
          if (!file && !fileId) throw new Error('Выберите XLSX-файл')
          if (file && file.size > 5 * 1024 * 1024) throw new Error('Файл превышает 5 МиБ')
          const bytes = file ? new Uint8Array(await file.arrayBuffer()) : await downloadWorkbook(fileId!)
          setDraft(await api<Draft>('/admin/drafts', await parse(bytes, group, year ? Number(year) : undefined), 'POST', true))
          setConfirm(undefined)
        })
      }}>
        {fileId && !file && <p className="subtext">Получен XLSX из Telegram</p>}
        <label className="field">Файл расписания<input type="file" accept=".xlsx" disabled={busy} onChange={e => setFile(e.target.files?.[0])} /></label>
        <label className="field">Год начала периода, если его нет в файле<input type="number" min="2000" max="2100" placeholder="2026" value={year} onChange={e => setYear(e.target.value)} disabled={busy} /></label>
        <button className="primary" disabled={busy || !file && !fileId}>{busy ? 'Разбираем файл…' : 'Сформировать черновик'}</button>
      </form>}
      {draft && <>
        <p className="subtext">{draft.group} · {periodLabel(draft.from, draft.to)} · v{draft.next}</p>
        <p>{draft.lessons.length} строк · {draft.lessons.filter(l => l.type === 'exam').length} экзамена · {draft.lessons.filter(l => l.type === 'credit').length} зачёта</p>
        <p>Добавлено {draft.diff.added} · Удалено {draft.diff.removed} · Без изменений {draft.diff.unchanged}</p>
        {!!draft.warnings.length && <details className="warnings" open><summary>Предупреждения ({draft.warnings.length})</summary>
          <ul>{draft.warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul></details>}
        <details className="warnings"><summary>Занятия по датам</summary>
          {[...new Set(draft.lessons.map(l => l.date))].map(d => <section key={d} className="result-day">
            <h4>{dateText(d, { dateStyle: 'full' })}</h4>
            <LessonList lessons={draft.lessons.filter(l => l.date === d)} holidays={holidays} now={0} />
          </section>)}
        </details>
        {confirm === 'publish' && <p className="message">Заменить расписание на этот период? Удаляемых строк: {draft.diff.removed}.</p>}
        <div className="actions">
          <button className="primary" disabled={busy} onClick={() => {
            if (confirm !== 'publish') return setConfirm('publish')
            void action(async () => {
              const result = await api<{ version: number }>(`/admin/publish/${draft.id}`, {}, 'POST', true)
              clearDraft(); onChange(); setMessage(`Опубликована версия v${result.version}`); await refresh()
            })
          }}>{confirm === 'publish' ? 'Подтвердить публикацию' : 'Опубликовать'}</button>
          <button className="secondary" disabled={busy} onClick={() => void action(async () => {
            await api(`/admin/draft/${draft.id}`, undefined, 'DELETE', true)
            clearDraft()
          })}>Отменить черновик</button>
        </div>
      </>}
    </div>
    <div className="panel"><h3>Предпраздничный режим</h3>
      <form onSubmit={e => {
        e.preventDefault()
        void action(async () => {
          await api('/admin/holiday', { date, group, enabled: !holidays.includes(date) }, 'PUT', true)
          onChange(); setMessage('Режим звонков сохранён')
        })
      }}>
        <label className="field">Дата<input type="date" value={date} onChange={e => setDate(e.target.value)} required /></label>
        <button className="secondary" disabled={busy || !date}>{holidays.includes(date) ? 'Снять режим' : 'Назначить режим'}</button>
      </form>
    </div>
    <div className="panel"><h3>История версий</h3>
      {!dashboard?.versions.length && <p className="subtext">Публикаций пока нет</p>}
      {dashboard?.versions.map((v, index) => <div className="version-row" key={v.number}>
        <div><strong>v{v.number} · {v.description}</strong><div className="subtext">{new Date(v.created).toLocaleString('ru', { timeZone: 'Asia/Yekaterinburg' })}</div></div>
        {index > 0 && <button className="secondary" disabled={busy} onClick={() => {
          if (confirm !== v.number) return setConfirm(v.number)
          void action(async () => {
            const result = await api<{ version: number }>('/admin/rollback', { group, current: dashboard.versions[0].number, target: v.number }, 'POST', true)
            setConfirm(undefined); onChange(); setMessage(`Восстановлено как v${result.version}`); await refresh()
          })
        }}>{confirm === v.number ? 'Подтвердить откат' : 'Восстановить'}</button>}
      </div>)}
    </div>
    <div className="panel"><h3>Рассылки группы</h3>
      {(Object.keys(preferences) as Preference[]).map(kind => <label className="toggle" key={kind}>
        <span>{preferences[kind]}</span><input type="checkbox" disabled={!dashboard || busy}
          checked={Boolean(dashboard && !dashboard.disabled.includes(kind))} onChange={e => {
            const enabled = e.target.checked
            void action(async () => {
              await api('/admin/notifications', { group, kind, enabled }, 'PUT', true)
              await refresh()
            })
          }} />
      </label>)}
    </div>
    <div className="panel"><h3>Группы и статистика</h3>
      <p>Пользователей: {dashboard?.users ?? '—'} · С подпиской: {dashboard?.subscribers ?? '—'}</p>
      <form onSubmit={e => {
        e.preventDefault()
        void action(async () => {
          const id = newGroup.trim().toUpperCase()
          await api('/admin/groups', { group: id }, 'POST', true)
          setNewGroup(''); onChange(); onGroup(id); setMessage(`Группа ${id} добавлена`)
        })
      }}>
        <label className="field">Новая группа<input value={newGroup} onChange={e => setNewGroup(e.target.value)} placeholder="П-61БС" required /></label>
        <button className="secondary" disabled={busy || Boolean(draft)}>Добавить группу</button>
      </form>
    </div>
  </section>
}
