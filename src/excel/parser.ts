import { SaxesParser } from 'saxes'
import { lessonKey, type Import, type Lesson, type LessonType } from '../shared/model'
import { shiftDate, validDate } from '../shared/time'
import { WorkbookZip } from './zip'

type Attributes = Record<string, string>
const clean = (s = '') => s.replace(/\s+/g, ' ').trim()
const groupPattern = /[А-ЯЁA-Z]{1,8}\s*[-–]\s*\d{1,5}\s*[А-ЯЁA-Z]{1,8}/iu
const groupName = (match: string) => match.toUpperCase().replace(/\s+/g, '').replace('–', '-')
const datePattern = /(?<!\d)(\d{1,2})[./-](\d{1,2})(?:[./-](\d{4}|\d{2})(?!\d))?(?!\d)/g
const dayLabel = /(?:понедельник|вторник|среда|четверг|пятница|суббота|воскресенье)/i
interface Cell { row: number; col: number; raw: string; numeric: boolean; address: string }
const column = (letters: string) => [...letters].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0)
function coordinates(address: string) {
  const m = /^([A-Z]{1,3})(\d{1,7})$/.exec(address)
  return m ? { row: Number(m[2]), col: column(m[1]) } : { row: 0, col: 0 }
}
function parseXml(xml: string, open: (tag: string, attrs: Attributes) => void,
  close = (_tag: string) => {}, content = (_s: string) => {}) {
  if (!xml) return
  const parser = new SaxesParser()
  parser.on('doctype', () => { throw new Error('DTD в XLSX запрещён') })
  parser.on('opentag', tag => open(tag.name.split(':').at(-1)!, tag.attributes))
  parser.on('closetag', tag => close(tag.name.split(':').at(-1)!))
  parser.on('text', content)
  parser.on('cdata', content)
  parser.write(xml).close()
}
function strings(xml: string) {
  const values: string[] = []
  let value = '', inside = false
  parseXml(xml, tag => {
    if (tag === 'si') value = ''
    if (tag === 't') inside = true
  }, tag => {
    if (tag === 'si') values.push(value)
    if (tag === 't') inside = false
  }, s => { if (inside) value += s })
  return values
}
function cells(xml: string, shared: string[]) {
  const values = new Map<string, Cell>(), merges = new Map<string, { row: number; col: number }>()
  let address = '', type = '', value = '', inside = false
  parseXml(xml, (tag, attrs) => {
    if (tag === 'c') { address = attrs.r ?? ''; type = attrs.t ?? 'n'; value = '' }
    if (address && (tag === 'v' || tag === 't')) inside = true
    if (tag === 'mergeCell') {
      const [start, end] = (attrs.ref ?? '').split(':')
      if (start && end) merges.set(start, coordinates(end))
    }
  }, tag => {
    if (tag === 'v' || tag === 't') inside = false
    if (tag !== 'c') return
    const raw = type === 's' ? shared[Number(value)] : value
    const position = coordinates(address)
    if (value && raw?.trim() && position.row) values.set(`${position.row}:${position.col}`, { ...position, raw, numeric: type === 'n', address })
    address = ''
  }, s => { if (inside) value += s })
  return { values, merges }
}
function toDate(parts: RegExpMatchArray, baseYear?: number, baseMonth?: number) {
  if (!parts[1] || !parts[2]) return undefined
  const [, day, month, yearText] = parts
  const monthNumber = Number(month)
  const year = yearText ? Number(yearText) + (yearText.length === 2 ? 2000 : 0) :
    baseYear === undefined ? undefined : baseYear + (baseMonth && baseMonth - monthNumber > 6 ? 1 : baseMonth && monthNumber - baseMonth > 6 ? -1 : 0)
  const result = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`
  return validDate(result) ? result : undefined
}
const labels: [RegExp, LessonType][] = [
  [/^(?:лекц|лек\b|лк)/iu, 'lecture'], [/^(?:практ|семинар|пр(?:\.|$))/iu, 'practice'],
  [/^(?:лаб|лр)/iu, 'lab'], [/^(?:экзам|экз)/iu, 'exam'], [/^(?:зач[её]т|диф.*зач)/iu, 'credit'],
  [/^конс/iu, 'consultation'],
]
const timePattern = /^(?:с\s+)?([01]?\d|2[0-3])[:.]([0-5]\d)(?:\s*(?:[-–—]|до)\s*([01]?\d|2[0-3])[:.]([0-5]\d))?\s*[:—–-]?\s*/iu
const normalizeTime = (hours: string, minutes: string) => `${hours.padStart(2, '0')}:${minutes}`
function parseLesson(date: string, pair: number, subject: Cell, place: Cell | undefined, warnings: string[]): Lesson {
  let text = clean(subject.raw)
  const matchTime = text.match(timePattern)
  let start = null, end = null
  if (matchTime) {
    start = normalizeTime(matchTime[1], matchTime[2])
    end = matchTime[3] ? normalizeTime(matchTime[3], matchTime[4]) : null
    text = text.slice(matchTime[0].length)
    if (end && end <= start) { end = null; warnings.push(`${subject.address}: некорректное время окончания · ${subject.raw}`) }
  }
  const untimed = /^(?:день самоподготовки|самоподготовка)$/iu.test(text)
  const event = untimed || /собрание|организационн|выдача|инструктаж/iu.test(text.split(';')[0])
  const notes = [...text.matchAll(/\(([^()]+)\)/g)].map(m => clean(m[1]))
  let title = text, teacher = '', type: LessonType = event ? 'event' : 'unknown'
  const structured = /^([^;]+);\s*([^:]+)(?::\s*(.*))?$/.exec(text)
  if (structured) {
    title = clean(structured[1])
    type = labels.find(([pattern]) => pattern.test(structured[2]))?.[1] ?? type
    teacher = clean(structured[3]?.replace(/\([^()]*\)/g, '').replace(/([а-яё])([А-ЯЁ]\.\s*[А-ЯЁ]\.)/g, '$1 $2'))
  } else if (event) {
    title = clean(text.replace(/\([^()]*\)/g, ''))
  }
  if (type === 'unknown') warnings.push(`${subject.address}: проверьте дисциплину, тип и преподавателя · ${subject.raw}`)
  const rawPlace = clean(place?.raw)
  const matchBuilding = rawPlace.match(/У\s*К\s*(?:№|N|#)?\s*(\d+)/iu)
  let room = matchBuilding ? clean(rawPlace.replace(matchBuilding[0], '')) : rawPlace
  room = room.replace(/^ауд(?:итория)?\.?\s*/iu, '')
  if (/^дист\.?\s*об\.?$/iu.test(room)) { notes.push('Дистанционное обучение'); room = '' }
  return { date, pair: untimed ? null : pair, title: title || subject.raw, type, teacher, room,
    building: matchBuilding ? `УК №${matchBuilding[1]}` : '', start, end, notes: [...new Set(notes)].join(' · '),
    raw: [subject.raw, place?.raw].filter(Boolean).join('\n') }
}

export async function parseWorkbook(bytes: Uint8Array<ArrayBuffer>, year?: number, selectedGroup?: string): Promise<Import> {
  if (year !== undefined && (!Number.isInteger(year) || year < 2000 || year > 2100)) throw new Error('Укажите год начала периода от 2000 до 2100')
  const zip = new WorkbookZip(bytes)
  const sheets: { name: string; id: string }[] = [], links = new Map<string, string>()
  let date1904 = false
  parseXml(await zip.xml('xl/workbook.xml'), (tag, attrs) => {
    if (tag === 'sheet') sheets.push({ name: attrs.name, id: attrs['r:id'] })
    if (tag === 'workbookPr') date1904 = ['1', 'true'].includes(attrs.date1904)
  })
  parseXml(await zip.xml('xl/_rels/workbook.xml.rels'), (tag, attrs) => {
    if (tag === 'Relationship' && attrs.Type?.endsWith('/worksheet') && attrs.TargetMode !== 'External') links.set(attrs.Id, attrs.Target.replace(/^\/?xl\//, ''))
  })
  const matching = selectedGroup && sheets.find(s => groupName(s.name) === selectedGroup)
  if (sheets.length !== 1 && !matching) throw new Error('Выберите группу, совпадающую с названием листа XLSX')
  const sheet = matching || sheets[0]
  const target = sheet && links.get(sheet.id)
  if (!target || !/^worksheets\/[\w.-]+\.xml$/.test(target)) throw new Error('Не найден лист расписания')
  const { values, merges } = cells(await zip.xml(`xl/${target}`), strings(await zip.xml('xl/sharedStrings.xml', true)))
  const get = (row: number, col: number) => values.get(`${row}:${col}`)
  const list = [...values.values()].sort((a, b) => a.col - b.col || a.row - b.row)
  const headerGroup = list.find(cell => /группа\s+[А-ЯЁA-Z]+\s*[-–]/iu.test(cell.raw))?.raw.match(groupPattern)?.[0]
  const detected = headerGroup ?? sheet.name.match(groupPattern)?.[0]
  if (!detected && !selectedGroup) throw new Error('Учебная группа не найдена')
  const group = detected ? groupName(detected) : selectedGroup!
  if (selectedGroup && group !== selectedGroup) throw new Error(`В файле указана группа ${group}`)
  const range = list.find(cell => /(?:период|\bс\s)/iu.test(cell.raw) && [...cell.raw.matchAll(datePattern)].length === 2)
  const bounds = range ? [...range.raw.matchAll(datePattern)] : []
  const first = toDate(bounds[0] ?? [], year)
  const firstMonth = bounds[0] ? Number(bounds[0][2]) : undefined
  const explicitYear = first ? Number(first.slice(0, 4)) : year
  const headers = list.filter(cell => cell !== range && Number(get(cell.row, cell.col + 1)?.raw) === 1 &&
    (cell.numeric && Number(cell.raw) > 30000 || dayLabel.test(cell.raw) || /^\s*\d{1,4}[./-]\d/.test(cell.raw)))
  const warnings: string[] = []
  const dates: string[] = []
  const lessons: Lesson[] = []
  let anchorYear = explicitYear, anchorMonth = firstMonth
  for (const [index, cell] of headers.entries()) {
    const parts = [...cell.raw.matchAll(datePattern)][0]
    const date = validDate(cell.raw.trim()) ? cell.raw.trim() : parts ? toDate(parts, anchorYear, anchorMonth) :
      cell.numeric && Number(cell.raw) > 30000 && Number(cell.raw) < 75000 ?
        shiftDate(date1904 ? '1904-01-01' : '1899-12-30', Math.floor(Number(cell.raw))) :
        undefined
    if (!date) throw new Error(`${cell.address}: не удалось определить дату «${clean(cell.raw)}». Укажите год начала периода при импорте`)
    dates.push(date)
    anchorYear = Number(date.slice(0, 4)); anchorMonth = Number(date.slice(5, 7))
    const last = Math.min(cell.row + 7, (merges.get(cell.address)?.row ?? Infinity) + 1,
      headers[index + 1]?.col === cell.col ? headers[index + 1].row : Infinity)
    for (let row = cell.row; row < last; row++) {
      const pair = Number(get(row, cell.col + 1)?.raw)
      const subject = get(row, cell.col + 2), room = get(row, cell.col + 3)
      if (!Number.isInteger(pair) || pair < 1 || pair > 7) {
        if (subject) warnings.push(`${subject.address}: не определён номер пары · ${subject.raw}`)
        continue
      }
      if (!subject) {
        if (room) warnings.push(`${room.address}: аудитория без дисциплины · ${room.raw}`)
        continue
      }
      const merged = merges.get(subject.address)
      if (merged && merged.row > row) warnings.push(`${subject.address}: объединены строки нескольких пар, проверьте продолжительность · ${subject.raw}`)
      const mergedRoom = room ?? [...merges].find(([address, end]) => {
        const pos = coordinates(address)
        return pos.col === cell.col + 3 && pos.row >= cell.row && pos.row < row && end.row >= row
      })
      lessons.push(parseLesson(date, pair, subject, Array.isArray(mergedRoom) ? get(coordinates(mergedRoom[0]).row, cell.col + 3) : mergedRoom, warnings))
    }
  }
  dates.sort()
  const from = first ?? dates[0], to = toDate(bounds[1] ?? [], explicitYear, firstMonth) ?? dates.at(-1)
  if (!from || !to || !dates.length || from > dates[0] || to < dates.at(-1)!) throw new Error('Не удалось определить период, охватывающий даты занятий')
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('')
  const unique = new Map(lessons.map(l => [lessonKey(l), l]))
  if (unique.size !== lessons.length) warnings.push('Повторяющиеся строки объединены')
  return { group, from, to, hash, warnings, lessons: [...unique.values()].sort((a, b) => a.date.localeCompare(b.date) || (a.pair ?? 0) - (b.pair ?? 0)) }
}
