// Read only the OOXML parts used by the importer. Bound both ZIP metadata and actual output.
export const maxFileSize = 5 * 1024 * 1024
export class WorkbookZip {
  private readonly view: DataView
  private readonly entries = new Map<string, { size: number; method: number; offset: number; compressed: number }>()
  constructor(private readonly bytes: Uint8Array<ArrayBuffer>) {
    if (bytes.length > maxFileSize || bytes.length < 22) throw new Error('Недопустимый размер XLSX (до 5 МиБ)')
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    let end = bytes.length - 22
    while (end >= Math.max(0, bytes.length - 65557) && (this.u32(end) !== 0x06054b50 || end + 22 + this.u16(end + 20) !== bytes.length)) end--
    if (end < 0 || this.u32(end) !== 0x06054b50 || this.u32(end + 4) !== 0) throw new Error('Ожидается обычный файл XLSX')
    const count = this.u16(end + 10)
    let offset = this.u32(end + 16)
    if (count > 256 || this.u16(end + 8) !== count || offset + this.u32(end + 12) !== end) throw new Error('Некорректный ZIP-каталог')
    let total = 0
    for (let i = 0; i < count; i++) {
      if (offset + 46 > end || this.u32(offset) !== 0x02014b50 || this.u16(offset + 8) & 1) throw new Error('Некорректная запись ZIP')
      const nameSize = this.u16(offset + 28)
      const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameSize))
      const method = this.u16(offset + 10), size = this.u32(offset + 24), compressed = this.u32(offset + 20)
      const local = this.u32(offset + 42)
      if (!name || this.entries.has(name) || local + 30 > offset || this.u32(local) !== 0x04034b50 || ![0, 8].includes(method)) throw new Error('Неподдерживаемая запись ZIP')
      const data = local + 30 + this.u16(local + 26) + this.u16(local + 28)
      if (data + compressed > offset || size > 16 * 1024 * 1024 || (total += size) > 32 * 1024 * 1024) throw new Error('Превышен предел распаковки XLSX')
      this.entries.set(name, { size, method, offset: data, compressed })
      offset += 46 + nameSize + this.u16(offset + 30) + this.u16(offset + 32)
    }
    if (offset !== end || !this.entries.has('[Content_Types].xml') || !this.entries.has('xl/workbook.xml')) throw new Error('Отсутствуют обязательные части XLSX')
  }
  private u16(n: number) { return this.view.getUint16(n, true) }
  private u32(n: number) { return this.view.getUint32(n, true) }
  async xml(name: string, optional = false) {
    const entry = this.entries.get(name)
    if (!entry && optional) return ''
    if (!entry) throw new Error(`Отсутствует часть XLSX: ${name}`)
    const input = this.bytes.subarray(entry.offset, entry.offset + entry.compressed)
    if (entry.method === 0 && input.length === entry.size) return new TextDecoder().decode(input)
    const output = new Uint8Array(entry.size)
    const reader = new Blob([input]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader()
    let written = 0
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        if (written + value.length > output.length) throw new Error('Превышен заявленный размер части XLSX')
        output.set(value, written)
        written += value.length
      }
    } finally {
      await reader.cancel().catch(() => undefined)
    }
    if (written !== output.length) throw new Error('Неполная часть XLSX')
    return new TextDecoder().decode(output)
  }
}
