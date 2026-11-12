import { readFileBytes, type DiskFile } from './files'
import { maxSegments, parseGcodeLines, pointCommand, type PathData } from './gcode'

const chunkBytes = 4 * 1024 * 1024
const maxLineBytes = 1024 * 1024
export const maxGcodeOverviewBytes = 128 * 1024 * 1024
export const sourcePageLines = 1024

export interface GcodeSourceIndex {
  lineCount: number
  offsets: number[]
  pointMode: boolean
}

export interface GcodeLineRange {
  first: number
  last: number
}

export const maxDetailLines = 2_000_000

async function indexSource(file: Blob | DiskFile): Promise<GcodeSourceIndex> {
  const offsets = [0]
  let lineCount = 1
  let lineStart = 0
  let afterCR = false
  let pointMode = false
  const decoder = new TextDecoder()
  let commandTail = ''
  for (let start = 0; start < file.size; start += chunkBytes) {
    const bytes = new Uint8Array(await readFileBytes(file, start, Math.min(start + chunkBytes, file.size)))
    if (!pointMode) {
      const last = start + bytes.length === file.size
      const text = commandTail + decoder.decode(bytes, { stream: !last })
      const boundary = last ? text.length : Math.max(text.lastIndexOf('\n'), text.lastIndexOf('\r')) + 1
      pointMode = pointCommand.test(text.slice(0, boundary))
      commandTail = text.slice(boundary)
    }
    for (let i = 0; i < bytes.length; i++) {
      const byte = bytes[i]
      const next = start + i + 1
      if (byte === 10 && afterCR) {
        lineStart = next
        if ((lineCount - 1) % sourcePageLines === 0) offsets[offsets.length - 1] = next
      } else if (byte === 10 || byte === 13) {
        lineStart = next
        lineCount++
        if ((lineCount - 1) % sourcePageLines === 0) offsets.push(next)
      } else if (next - lineStart > maxLineBytes) {
        throw new Error(`第 ${lineCount} 行超过 1 MiB，无法预览。`)
      }
      afterCR = byte === 13
    }
  }
  return { lineCount, offsets, pointMode }
}

async function readPath(file: Blob | DiskFile, index: GcodeSourceIndex, overview: boolean, range?: GcodeLineRange,
  onProgress?: (processedLines: number) => void): Promise<PathData> {
  const parser = parseGcodeLines(index.pointMode, { ...range, overview })
  parser.next()
  const decoder = new TextDecoder()
  let tail = ''
  let processedLines = 0
  let lastProgress = performance.now()
  for (let offset = 0; offset < file.size; offset += chunkBytes) {
    const last = offset + chunkBytes >= file.size
    let text = tail + decoder.decode(await readFileBytes(file, offset, Math.min(offset + chunkBytes, file.size)), { stream: !last })
    const trailingCR = !last && text.endsWith('\r')
    if (trailingCR) text = text.slice(0, -1)
    let start = 0
    for (const separator of text.matchAll(/\r\n|\r|\n/g)) {
      const result = parser.next(text.slice(start, separator.index))
      if (result.done) return result.value
      if (onProgress && ++processedLines % 8192 === 0 && performance.now() - lastProgress >= 100) {
        lastProgress = performance.now()
        onProgress(processedLines)
      }
      start = separator.index + separator[0].length
    }
    tail = text.slice(start) + (trailingCR ? '\r' : '')
  }
  if (tail) {
    const result = parser.next(tail)
    if (result.done) return result.value
  }
  const result = parser.next(null)
  if (!result.done) throw new Error('G-code 解析未完成。')
  return result.value
}

export async function loadGcodeFile(file: Blob | DiskFile, index?: GcodeSourceIndex, range?: GcodeLineRange,
  onProgress?: (processedLines: number) => void) {
  const sourceIndex = index ?? await indexSource(file)
  let overview = !range && (file.size > maxGcodeOverviewBytes || sourceIndex.lineCount > maxSegments)
  let path = await readPath(file, sourceIndex, overview, range, onProgress)
  if (!range && path.limitReached) {
    overview = true
    path = await readPath(file, sourceIndex, true)
  }
  let loadedRange = range
  if (range && path.limitReached && path.issue && path.issue.line > range.first) {
    loadedRange = { first: range.first, last: path.issue.line - 1 }
    path.issue = null
  }
  return { sourceIndex, path, overview, loadedRange }
}

export async function readSourcePage(file: Blob | DiskFile, index: GcodeSourceIndex, row: number) {
  const page = Math.floor(row / sourcePageLines)
  const first = page * sourcePageLines
  const end = index.offsets[page + 2] ?? file.size
  const text = new TextDecoder().decode(await readFileBytes(file, index.offsets[page], end))
  return { first, lines: text.split(/\r\n|\r|\n/).slice(0, Math.min(sourcePageLines * 2, index.lineCount - first)) }
}
