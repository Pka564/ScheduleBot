import { useMemo, useRef } from 'react'
import { lessonKey, searchLessons, types, type Lesson, type LessonType, type Schedule } from '../shared/model'
import { countdown, dayState, inPeriod, instant, lessonTime, monday, shiftDate } from '../shared/time'
import { dateText } from './client'
import { Icon } from './icons'

const dayNames = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс']
export const longDate = (date: string) => dateText(date, { day: 'numeric', month: 'long', weekday: 'long' })
const shortDate = (date: string) => dateText(date, { day: 'numeric', month: 'short' })
export const periodLabel = (from: string, to: string) => `${shortDate(from)} — ${shortDate(to)}`
const stateLabels = {
  unpublished: ['Расписание пока не опубликовано', 'Занятия появятся здесь после обновления.'],
  empty: ['Сегодня занятий нет', 'На этот день ничего не запланировано.'],
  untimed: ['Занятия без времени', 'Подробности смотрите в расписании на сегодня.'],
  unknownEnd: ['Время окончания не указано', 'Подробности смотрите в расписании на сегодня.'],
  done: ['На сегодня всё 🎉', 'Пары закончились'],
  before: ['До начала занятий', ''],
  active: ['Сейчас идёт пара', ''],
  longBreak: ['Большая перемена', ''],
  gap: ['Свободное окно', ''],
  break: ['Перемена', ''],
}
export function StatusCard({ data, today, now, onDate }: { data: Schedule; today: string; now: number; onDate: (date: string) => void }) {
  const state = dayState(today, inPeriod(today, data.periods), data.lessons.filter(l => l.date === today), data.holidays, now)
  const [title, description] = stateLabels[state.kind]
  const focus = state.kind === 'active' ? state.active.lesson : 'next' in state ? state.next?.lesson : undefined
  const start = focus && lessonTime(focus, data.holidays).start
  const future = data.lessons.find(l => l.date > today)
  return <section className="status-card" aria-label="Состояние учебного дня">
    <div className="status-label"><span className="live-dot" /> Сегодня · {shortDate(today)}</div>
    <div className="status-mark"><Icon name={state.kind === 'done' ? 'check' : state.kind === 'unpublished' ? 'calendar' : 'clock'} /></div>
    <h2>{title}</h2>
    {focus ? <>
      <p className="focus-title">{focus.title}</p>
      <p className="status-detail">{[focus.pair && `${focus.pair}-я пара`, start && `в ${start}`, focus.room, focus.building].filter(Boolean).join(' · ')}</p>
    </> : <p>{description}</p>}
    {typeof state.seconds === 'number' && <div className="timer"><Icon name="clock" /> {countdown(state.seconds)}</div>}
    {state.kind === 'active' && <>
      <progress value={state.progress} max={1} aria-label="Прогресс пары" />
      {state.next && <p className="status-detail">Далее · {state.next.lesson.title}</p>}
    </>}
    {!focus && future && <button className="status-link" onClick={() => onDate(future.date)}>Ближайшие занятия · {shortDate(future.date)} <Icon name="arrow" /></button>}
  </section>
}
export function Calendar({ data, date, today, onDate }: { data: Schedule; date: string; today: string; onDate: (date: string) => void }) {
  const start = monday(date), end = shiftDate(start, 6)
  const lower = [today, data.periods[0]?.from ?? today].sort()[0]
  const upper = [today, data.periods.at(-1)?.to ?? today].sort().at(-1)!
  const canBack = start > monday(lower), canForward = end < upper
  const move = (direction: number) => {
    if (direction < 0 && !canBack || direction > 0 && !canForward) return
    onDate(shiftDate(date, 7 * direction))
  }
  const touch = useRef<{ x: number; y: number } | undefined>(undefined)
  return <section className="calendar" aria-label="Календарь" onTouchStart={e => {
    touch.current = { x: e.touches[0].clientX, y: e.touches[0].clientY }
  }} onTouchEnd={e => {
    const origin = touch.current
    touch.current = undefined
    if (!origin) return
    const dx = e.changedTouches[0].clientX - origin.x, dy = e.changedTouches[0].clientY - origin.y
    if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy)) move(dx < 0 ? 1 : -1)
  }}>
    <div className="calendar-top">
      <div><h2>Календарь</h2><div className="subtext">{periodLabel(start, end)}</div></div>
      <div className="calendar-controls">
        <button className="icon-button" aria-label="Предыдущая неделя" onClick={() => move(-1)} disabled={!canBack}><Icon name="left" /></button>
        <button className="icon-button" aria-label="Следующая неделя" onClick={() => move(1)} disabled={!canForward}><Icon name="right" /></button>
      </div>
    </div>
    <div className="days">
      {dayNames.map((day, index) => {
        const current = shiftDate(start, index), entries = data.lessons.filter(l => l.date === current)
        const type = entries.some(l => l.type === 'exam') ? 'exam' : entries.some(l => l.type === 'credit') ? 'credit' : entries.length ? 'lecture' : ''
        return <button key={current} className={`day ${date === current ? 'selected' : ''} ${today === current ? 'current-day' : ''}`}
          aria-pressed={date === current} aria-current={today === current ? 'date' : undefined}
          aria-label={`${longDate(current)}${type ? ', занятия есть' : ''}`} onClick={() => onDate(current)}>
          <span>{day}</span><strong>{Number(current.slice(8))}</strong><i className={type} />
        </button>
      })}
    </div>
    {date !== today && <button className="text-button calendar-today" onClick={() => onDate(today)}>Вернуться к сегодня</button>}
  </section>
}
export function LessonList({ lessons, holidays, now, navigate }: { lessons: Lesson[]; holidays: string[]; now: number; navigate?: (date: string) => void }) {
  return <div className="lessons">
    {lessons.map(l => {
      const { start, end } = lessonTime(l, holidays)
      const state = end && now >= instant(l.date, end) ? 'finished' : start && end && now >= instant(l.date, start) ? 'running' : ''
      const content = <>
        <div className="lesson-time">{start ? <><strong>{start}</strong>{end && <span>{end}</span>}</> : <span>—</span>}</div>
        <div className="lesson-content">
          <h3>{l.pair !== null && <span className="pair-number">{l.pair}. </span>}{l.title}</h3>
          <div className="lesson-meta"><span className={`tag ${l.type}`}>{types[l.type]}</span>
            {(l.room || l.building) && <span className="location"><Icon name="pin" /> {[l.room, l.building].filter(Boolean).join(' · ')}</span>}
          </div>
          {l.teacher && <p>{l.teacher}</p>}{l.notes && <p className="notes">{l.notes}</p>}
        </div>
        {navigate && <Icon name="right" className="result-arrow" />}
      </>
      const className = `lesson ${l.type} ${state}`
      return navigate ? <button key={lessonKey(l)} className={className} onClick={() => navigate(l.date)}>{content}</button> :
        <article key={lessonKey(l)} className={className}>{content}</article>
    })}
  </div>
}
export function Daily({ data, date, today, now }: { data: Schedule; date: string; today: string; now: number }) {
  const entries = data.lessons.filter(l => l.date === date)
  return <section className="daily" aria-label="Занятия на выбранную дату">
    <div className="daily-heading"><div><h2>{date === today ? 'Сегодня' : dateText(date, { day: 'numeric', month: 'long' })}</h2>
      <p className="subtext">{date === today ? longDate(date) : dateText(date, { weekday: 'long' })}</p></div>
      {entries.length > 0 && <span className="count">{entries.length} в расписании</span>}
    </div>
    {data.holidays.includes(date) && <p className="message">Предпраздничный режим звонков</p>}
    {entries.length ? <LessonList lessons={entries} holidays={data.holidays} now={now} /> :
      <div className="empty"><Icon name="calendar" /><h3>{inPeriod(date, data.periods) ? 'Занятий нет' : 'Нет опубликованного расписания'}</h3></div>}
  </section>
}
const quick: [LessonType, string][] = [['exam', 'Экзамены'], ['credit', 'Зачёты'], ['consultation', 'Консультации'], ['lecture', 'Лекции'], ['practice', 'Практики'], ['lab', 'Лабораторные']]
export function Search({ data, query, filter, onQuery, onFilter, onDate }: { data: Schedule; query: string; filter: string;
  onQuery: (s: string) => void; onFilter: (s: string) => void; onDate: (s: string) => void }) {
  const groups = useMemo(() => {
    const byDate = new Map<string, Lesson[]>()
    for (const l of searchLessons(data.lessons, query, filter)) byDate.set(l.date, [...(byDate.get(l.date) ?? []), l])
    return byDate
  }, [data, query, filter])
  return <section className="search-panel">
    <label className="search-input"><Icon name="search" /><input type="search" value={query} onChange={e => onQuery(e.target.value)}
      placeholder="Дисциплина, преподаватель, аудитория…" aria-label="Поиск по расписанию" /></label>
    <div className="filters"><button className={!filter ? 'chosen' : ''} onClick={() => onFilter('')}>Все</button>
      {quick.map(([key, label]) => <button key={key} aria-pressed={filter === key} className={filter === key ? 'chosen' : ''} onClick={() => onFilter(filter === key ? '' : key)}>{label}</button>)}</div>
    {!groups.size && <div className="empty"><Icon name="search" /><h3>Ничего не найдено</h3><p>Попробуйте другой запрос или фильтр.</p></div>}
    {[...groups].map(([date, lessons]) => <div className="result-day" key={date}><h2>{longDate(date)}</h2><LessonList lessons={lessons} holidays={data.holidays} now={0} navigate={onDate} /></div>)}
  </section>
}
