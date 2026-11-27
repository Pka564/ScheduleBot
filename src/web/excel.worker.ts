import { parseWorkbook } from '../excel/parser'
self.onmessage = async ({ data }: MessageEvent<{ bytes: ArrayBuffer; year?: number; group: string }>) => {
  try { self.postMessage({ result: await parseWorkbook(new Uint8Array(data.bytes), data.year, data.group) }) }
  catch (error) { self.postMessage({ error: error instanceof Error ? error.message : 'Не удалось разобрать XLSX' }) }
}
