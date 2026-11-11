import { expect, it } from 'vitest'
import { maxGcodeBytes } from '../src/shared/files'
import { engraving } from '../src/shared/gcode'
import { loadGcodeFile, readSourcePage } from '../src/shared/gcodeFile'

it('indexes mixed line endings and restores state for a range after a chunk boundary', async () => {
  const prefix = 'G91\rM4S80\nG1X2\r\n'
  const comment = ';' + 'x'.repeat(1022) + '\n'
  const padding = comment.repeat(4095)
  const boundary = ';' + 'y'.repeat(4 * 1024 ** 2 - prefix.length - padding.length - 2)
  const file = new Blob([prefix, padding, boundary, '\r\nG1X3\r\nG1X4'])
  const full = await loadGcodeFile(file)
  const last = full.sourceIndex.lineCount
  expect(last).toBe(4101)
  const page = await readSourcePage(file, full.sourceIndex, last - 1)
  expect(page.lines.slice(-2)).toEqual(['G1X3', 'G1X4'])
  const detail = await loadGcodeFile(file, full.sourceIndex, { first: last, last })
  expect(detail.path.issue).toBeNull()
  expect([...detail.path.positions]).toEqual([5, 0, 0, 9, 0, 0])
  expect([...detail.path.lines]).toEqual([last])
  expect(detail.path.kinds[0]).toBe(engraving)
  expect(detail.path.powers[0]).toBe(80)
})

it('samples motions past the previous two-million segment limit', async () => {
  const moves = 2_000_020
  const file = new Blob(['G91\n', 'G1X1\n'.repeat(moves)])
  const result = await loadGcodeFile(file)
  expect(result.overview).toBe(true)
  expect(result.path.issue).toBeNull()
  expect(result.path.kinds.length).toBeLessThanOrEqual(500_000)
  expect(result.path.lines.at(-1)).toBeGreaterThan(2_000_000)
  expect(result.path.bounds?.max).toEqual([moves, 0, 0])
  const last = moves + 1
  const detail = await loadGcodeFile(file, result.sourceIndex, { first: last, last })
  expect([...detail.path.positions]).toEqual([moves - 1, 0, 0, moves, 0, 0])
}, 30_000)

it('ends a detail before a multi-segment line that would cross the geometry cap', async () => {
  const moves = 1_999_999
  const arcLine = moves + 2
  const file = new Blob(['G91\n', 'G1X1\n'.repeat(moves), 'G3X2I1\nG1X1'])
  const detail = await loadGcodeFile(file, undefined, { first: 2, last: arcLine })
  expect(detail.path.issue).toBeNull()
  expect(detail.path.limitReached).toBe(true)
  expect(detail.loadedRange).toEqual({ first: 2, last: arcLine - 1 })
  expect(detail.path.kinds.length).toBe(moves)
  expect(detail.path.bounds?.max).toEqual([moves, 0, 0])
  const next = await loadGcodeFile(file, detail.sourceIndex, { first: arcLine, last: arcLine + 1 })
  expect(next.path.issue).toBeNull()
  expect([...new Set(next.path.lines)]).toEqual([arcLine, arcLine + 1])
  expect(next.path.end).toEqual([moves + 3, 0, 0])
}, 30_000)

it.skipIf(!process.env.LDS_LARGE_FILE_TEST)('reads a 1 GiB source and locates its final motion', async () => {
  const block = new Blob([(';' + 'x'.repeat(510) + '\n').repeat(2048)])
  const first = 'G91\nG1X2\n'
  const last = 'G1X3'
  const padding = ';' + 'x'.repeat(block.size - first.length - last.length - 2) + '\n'
  const file = new Blob([first, ...Array<Blob>(1023).fill(block), padding, last])
  expect(file.size).toBe(maxGcodeBytes)
  const result = await loadGcodeFile(file)
  expect(result.overview).toBe(true)
  expect(result.path.issue).toBeNull()
  expect(result.path.end).toEqual([5, 0, 0])
  const row = result.sourceIndex.lineCount - 1
  const page = await readSourcePage(file, result.sourceIndex, row)
  expect(page.lines[row - page.first]).toBe(last)
}, 120_000)
