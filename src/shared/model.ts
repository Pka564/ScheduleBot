export const mainGroup = 'П-61БС'
export const types = {
  lecture: 'Лекция', practice: 'Практика', lab: 'Лабораторная', exam: 'Экзамен',
  credit: 'Зачёт', consultation: 'Консультация', event: 'Мероприятие', unknown: 'Тип не указан',
} as const
export type LessonType = keyof typeof types
export interface Lesson {
  date: string
  pair: number | null
  title: string
  type: LessonType
  teacher: string
  room: string
  building: string
  start: string | null
  end: string | null
  notes: string
  raw: string
}
export interface Period { from: string; to: string }
export interface Import extends Period {
  group: string
  lessons: Lesson[]
  warnings: string[]
  hash: string
}
export interface Schedule {
  group: string
  version: number
  updated: string | null
  periods: Period[]
  lessons: Lesson[]
  holidays: string[]
}
export interface Draft extends Import {
  id: string
  next: number
  diff: { added: number; removed: number; unchanged: number }
}
export interface Version { number: number; created: string; description: string }
export const preferences = {
  changes: 'Изменения расписания',
  evening: 'Расписание на завтра в 19:00',
  morning: 'Расписание на сегодня в 07:00',
  reminder: 'За 10–15 минут до ближайшей пары',
} as const
export type Preference = keyof typeof preferences
export type Settings = Record<Preference, boolean> & { group: string }
export const defaultSettings: Settings = {
  group: mainGroup, changes: false, evening: false, morning: false, reminder: false,
}
export function lessonKey(lesson: Lesson) {
  return JSON.stringify([lesson.date, lesson.pair, lesson.title, lesson.type, lesson.teacher,
    lesson.room, lesson.building, lesson.start, lesson.end, lesson.notes])
}
const searchDateFormat = new Intl.DateTimeFormat('ru-RU', { timeZone: 'UTC', day: 'numeric', month: 'long' })
export function searchLessons(lessons: Lesson[], query: string, type?: string) {
  const normalize = (value: string) => value.toLocaleLowerCase('ru').replaceAll('ё', 'е')
  const terms = normalize(query.trim()).split(/\s+/).filter(Boolean)
  return lessons.filter(l => {
    if (type && type !== l.type) return false
    if (!terms.length) return true
    const [y, m, d] = l.date.split('-')
    const localizedDate = searchDateFormat.format(new Date(l.date))
    const searchable = normalize([l.title, l.teacher, l.room, l.building, types[l.type], l.notes, l.date, `${d}.${m}.${y}`, localizedDate].join(' '))
    return terms.every(term => searchable.includes(term))
  })
}
