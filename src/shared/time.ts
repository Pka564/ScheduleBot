import type { Lesson, Period } from './model'
export const zone = 'Asia/Yekaterinburg'
const dayFormat = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' })
export const localDate = (now = Date.now()) => dayFormat.format(now)
export const weekday = (date: string) => new Date(date).getUTCDay()
export const shiftDate = (date: string, days: number) => new Date(Date.parse(date) + days * 86400000).toISOString().slice(0, 10)
export const monday = (date: string) => shiftDate(date, -((weekday(date) + 6) % 7))
export const inPeriod = (date: string, periods: Period[]) => periods.some(p => date >= p.from && date <= p.to)
export const validDate = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d\d-\d\d$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value
const morning = [['08:30', '10:00'], ['10:15', '11:45'], ['12:00', '13:30']]
const weekdays = [...morning, ['14:15', '15:45'], ['16:00', '17:30'], ['17:40', '19:05'], ['19:15', '20:40']]
const saturday = [...morning, ['13:45', '15:15'], ['15:30', '17:00'], ['17:10', '18:40']]
const holiday = [...morning, ['13:45', '14:45'], ['15:00', '16:00']]
export function lessonTime(lesson: Lesson, holidays: string[]) {
  if (lesson.start) return { start: lesson.start, end: lesson.end }
  const day = weekday(lesson.date)
  const table = holidays.includes(lesson.date) ? holiday : day === 6 ? saturday : day === 0 ? [] : weekdays
  const [start = null, end = null] = table[(lesson.pair ?? 0) - 1] ?? []
  return { start, end }
}
export const instant = (date: string, time: string) => Date.parse(`${date}T${time}:00+05:00`)
export function timeline(lessons: Lesson[], holidays: string[]) {
  return lessons.flatMap(lesson => {
    const { start, end } = lessonTime(lesson, holidays)
    return start ? [{ lesson, start: instant(lesson.date, start), end: end ? instant(lesson.date, end) : null }] : []
  }).sort((a, b) => a.start - b.start)
}
export function dayState(date: string, published: boolean, lessons: Lesson[], holidays: string[], now: number) {
  if (!published) return { kind: 'unpublished' } as const
  if (!lessons.length) return { kind: 'empty' } as const
  const entries = timeline(lessons, holidays)
  if (!entries.length) return { kind: 'untimed' } as const
  const next = entries.find(entry => now < entry.start)
  const active = entries.find(entry => entry.end !== null && entry.start <= now && now < entry.end)
  if (active && active.end !== null) return { kind: 'active', active, next, seconds: (active.end - now) / 1000, progress: (now - active.start) / (active.end - active.start) } as const
  const previous = entries.findLast(entry => entry.start <= now)
  if (!next) return { kind: previous?.end === null ? 'unknownEnd' : 'done' } as const
  const seconds = (next.start - now) / 1000
  if (!previous) return { kind: 'before', next, seconds } as const
  const longBreak = weekday(date) >= 1 && weekday(date) <= 5 && !holidays.includes(date) &&
    now >= instant(date, '13:30') && now < instant(date, '14:15')
  const gap = (next.lesson.pair ?? 0) - (previous.lesson.pair ?? 0) > 1
  return { kind: longBreak ? 'longBreak' : gap ? 'gap' : 'break', next, seconds } as const
}
export function countdown(seconds: number) {
  const total = Math.max(0, Math.ceil(seconds))
  return [Math.floor(total / 3600), Math.floor(total / 60) % 60, total % 60].map(n => String(n).padStart(2, '0')).join(':')
}
