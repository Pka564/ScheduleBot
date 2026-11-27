import { afterEach, describe, expect, it, vi } from 'vitest'
import { countdown, dayState, instant, lessonTime, localDate } from '../src/shared/time'
import { searchLessons, type Lesson } from '../src/shared/model'
const monday = '2026-11-30'
export const lesson = (date = monday, pair: number | null = 1, fields: Partial<Lesson> = {}): Lesson => ({
  date, pair, title: 'Линейная алгебра', teacher: 'Куанышев В.Т.', type: 'lecture', room: '408', building: 'УК №1',
  start: null, end: null, raw: '', notes: '', ...fields,
})
afterEach(() => vi.useRealTimers())
describe('Звонки и состояние дня', () => {
  it('использует точное время и Екатеринбург независимо от устройства', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-29T19:00:00Z'))
    expect(localDate()).toBe(monday)
    expect(lessonTime(lesson(monday, 7), [])).toEqual({ start: '19:15', end: '20:40' })
    expect(lessonTime(lesson('2026-12-05', 6), [])).toEqual({ start: '17:10', end: '18:40' })
    expect(lessonTime(lesson(monday, 4), [monday])).toEqual({ start: '13:45', end: '14:45' })
    expect(lessonTime(lesson(monday, 6, { start: '09:00' }), [monday])).toEqual({ start: '09:00', end: null })
    expect(lessonTime(lesson(monday, 6), [monday])).toEqual({ start: null, end: null })
  })
  it('проверяет границы занятия, большую перемену, окно и завершение по системным часам', () => {
    vi.useFakeTimers()
    const state = (time: string, pairs: number[]) => {
      vi.setSystemTime(instant(monday, time))
      return dayState(monday, true, pairs.map(p => lesson(monday, p)), [], Date.now())
    }
    expect(state('08:29', [1])).toMatchObject({ kind: 'before', seconds: 60 })
    expect(state('08:30', [1])).toMatchObject({ kind: 'active', progress: 0, seconds: 5400 })
    expect(state('09:15', [1])).toMatchObject({ kind: 'active', progress: 0.5 })
    expect(state('10:00', [1,2])).toMatchObject({ kind: 'break', seconds: 900 })
    expect(state('10:00', [1,3])).toMatchObject({ kind: 'gap', seconds: 7200 })
    expect(state('13:30', [3,5])).toMatchObject({ kind: 'longBreak', next: { lesson: { pair: 5 } } })
    expect(state('14:15', [3,5])).toMatchObject({ kind: 'gap' })
    expect(state('17:30', [3,5])).toMatchObject({ kind: 'done' })
    expect(dayState(monday, false, [], [], Date.now()).kind).toBe('unpublished')
    expect(dayState(monday, true, [], [], Date.now()).kind).toBe('empty')
    expect(countdown(60.1)).toBe('00:01:01')
  })
})
it('ищет по дисциплине, преподавателю, аудитории, корпусу, типу и дате', () => {
  const l = lesson(monday, 1, { type: 'credit' })
  for (const query of ['АЛГЕБР', 'куаныш', '408', '№1', 'ЗАЧЕТ', '30.11', 'ноября', 'алгебр 408'])
    expect(searchLessons([l], query)).toEqual([l])
  expect(searchLessons([l], '', 'exam')).toEqual([])
})
