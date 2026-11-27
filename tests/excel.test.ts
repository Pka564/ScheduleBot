import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { deflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { parseWorkbook } from '../src/excel/parser'

function makeWorkbook(sheet: string) {
  const parts = {
    '[Content_Types].xml': '<Types/>',
    'xl/workbook.xml': '<workbook xmlns:r="r"><sheets><sheet name="П-61БС" r:id="s"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="s" Type="x/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': sheet,
  }
  const records: Buffer[] = [], directory: Buffer[] = []
  let offset = 0
  for (const [key, xml] of Object.entries(parts)) {
    const name = Buffer.from(key), data = deflateRawSync(xml), size = Buffer.byteLength(xml)
    const local = Buffer.alloc(30), central = Buffer.alloc(46)
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(8, 8); local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(size, 22); local.writeUInt16LE(name.length, 26)
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(8, 10); central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(size, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42)
    records.push(local, name, data); directory.push(central, name); offset += local.length + name.length + data.length
  }
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(records.length / 3, 8); end.writeUInt16LE(records.length / 3, 10)
  end.writeUInt32LE(Buffer.concat(directory).length, 12); end.writeUInt32LE(offset, 16)
  return new Uint8Array(Buffer.concat([...records, ...directory, end]))
}
const cell = (ref: string, value: string) => `<c r="${ref}" t="inlineStr"><is><t>${value}</t></is></c>`
const sample = makeWorkbook(`<worksheet><sheetData>
  <row>${cell('A1', 'ГРУППА П-61БС')}${cell('A2', 'Период с 31.12 по 04.01')}</row>
  <row>${cell('A7', 'ЧЕТВЕРГ 31.12')}${cell('B7', '1')}${cell('C7', '9:00 Собрание')}${cell('D7', 'VII рим.')}${cell('E7', 'ПОНЕДЕЛЬНИК 04.01')}${cell('F7', '1')}${cell('G7', '10:00–10:50 Алгебра; лабораторная: И.И. Иванов (установка)')}</row>
  <row>${cell('B8', '2')}${cell('F8', '2')}</row>
  <row>${cell('B9', '3')}${cell('C9', 'Запись без типа')}${cell('F9', '3')}</row>
  </sheetData><mergeCells><mergeCell ref="A7:A9"/><mergeCell ref="E7:E9"/></mergeCells></worksheet>`)
describe('Парсер XLSX', () => {
  it('разбирает недели по горизонтали, объединённые даты, пустые пары и переход года', async () => {
    const data = await parseWorkbook(sample, 2026)
    expect(data).toMatchObject({ group: 'П-61БС', from: '2026-12-31', to: '2027-01-04' })
    expect(data.lessons.map(l => [l.date, l.pair, l.type, l.start, l.end])).toEqual([
      ['2026-12-31', 1, 'event', '09:00', null], ['2026-12-31', 3, 'unknown', null, null],
      ['2027-01-04', 1, 'lab', '10:00', '10:50'],
    ])
    expect(data.lessons[1].raw).toBe('Запись без типа')
    expect(data.lessons[2].notes).toBe('установка')
    expect(data.warnings).toHaveLength(1)
  })
  it('отклоняет неверный формат, неизвестный год, не ту группу и чрезмерную распаковку', async () => {
    await expect(parseWorkbook(new Uint8Array(22))).rejects.toThrow()
    await expect(parseWorkbook(sample)).rejects.toThrow('Укажите год')
    await expect(parseWorkbook(sample, 2026, 'П-52БС')).rejects.toThrow('П-61БС')
    await expect(parseWorkbook(makeWorkbook('<s>' + 'x'.repeat(17 * 1024 * 1024) + '</s>'))).rejects.toThrow('распаковки')
  })
  it.skipIf(!process.env.SCHEDULEBOT_TEST_XLSX)('сверяет все 43 позиции исходного файла П-61БС', async () => {
    const buffer = await readFile(process.env.SCHEDULEBOT_TEST_XLSX!)
    const result = await parseWorkbook(new Uint8Array(buffer))
    const sourceRows = result.lessons.map(l => [l.date, l.pair ?? 0, l.raw])
    expect(createHash('sha256').update(JSON.stringify(sourceRows)).digest('hex'))
      .toBe('a86164e8d857057f32dad55ca6003b808376e1d1d45394a1706dbbc6ec39db3d')
    expect(result.hash).toBe(createHash('sha256').update(buffer).digest('hex'))
    expect(result).toMatchObject({ group: 'П-61БС', from: '2026-11-30', to: '2026-12-19', warnings: [] })
    const byDate = Object.fromEntries([...new Set(result.lessons.map(l => l.date))].map(date => [
      date.slice(5), result.lessons.filter(l => l.date === date).map(l => l.pair ?? 0),
    ]))
    expect(byDate).toEqual({
      '11-30': [1,4,5,6], '12-01': [5,6], '12-02': [4,5,6], '12-03': [1,2], '12-04': [2], '12-05': [0],
      '12-07': [3,4], '12-08': [3,4,5], '12-09': [4,5], '12-10': [3], '12-11': [2,3,4,5,6], '12-12': [0],
      '12-14': [1,2], '12-15': [3,4], '12-16': [2,3,4,5], '12-17': [2,3,4,5,6], '12-18': [3,4], '12-19': [0],
    })
    expect(result.lessons.reduce<Record<string, number>>((counts, l) => ({ ...counts, [l.type]: (counts[l.type] ?? 0) + 1 }), {}))
      .toEqual({ lecture: 17, practice: 17, exam: 2, credit: 3, event: 4 })
    expect(result.lessons[0]).toMatchObject({ title: 'Организационное собрание', start: '09:00', end: null, room: 'VII рим.' })
    expect(result.lessons.some(l => l.notes === 'установка · с гр. И-61бс' && l.building === 'УК №1')).toBe(true)
    expect(result.lessons.some(l => l.notes.includes('Дистанционное обучение') && !l.room)).toBe(true)
    expect(result.lessons.some(l => l.building === 'УК №3' && l.room === '405')).toBe(true)
  })
})
