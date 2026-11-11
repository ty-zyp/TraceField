export type XYZ = [number, number, number]
export const rapid = 0
export const travel = 1
export const engraving = 2
export const pulse = 3
export const layerChange = 4
export const maxSegments = 2_000_000

export interface DiagnosticGroup {
  reason: string
  count: number
  firstLine: number
}

export interface PathData {
  crystal: boolean
  curved: boolean
  pointMode: boolean
  positions: Float32Array
  kinds: Uint8Array
  powers: Float32Array
  lines: Uint32Array
  distances: Float64Array
  bounds: { min: XYZ; max: XYZ } | null
  end: XYZ
  issue: { line: number; message: string } | null
  limitReached: boolean
  previewedLoops: number
  skipped: { count: number; firstLine: number; codes: number[] } | null
  ignored: { count: number; examples: { line: number; message: string }[] } | null
  diagnostics: DiagnosticGroup[]
}

class UnsupportedBlock extends Error {}

function arcPoints(from: XYZ, to: XYZ, words: Map<string, number>, units: number, clockwise: boolean): XYZ[] {
  const [x, y, z] = from
  const dx = to[0] - x
  const dy = to[1] - y
  const chord = Math.hypot(dx, dy)
  const r = words.get('R')
  const i = words.get('I')
  const j = words.get('J')
  let cx: number
  let cy: number
  if (r !== undefined) {
    if (i !== undefined || j !== undefined) throw new UnsupportedBlock('圆弧不能混用 R 与 I/J。')
    const radius = Math.abs(r * units)
    if (chord === 0 || chord / 2 > radius + 1e-7) throw new UnsupportedBlock('圆弧半径与端点不匹配。')
    const offset = Math.sqrt(Math.max(0, radius ** 2 - (chord / 2) ** 2))
    const sign = (clockwise ? -1 : 1) * Math.sign(r)
    cx = x + dx / 2 - sign * dy / chord * offset
    cy = y + dy / 2 + sign * dx / chord * offset
  } else {
    if (i === undefined && j === undefined) throw new UnsupportedBlock('圆弧缺少 I/J 或 R。')
    cx = x + (i ?? 0) * units
    cy = y + (j ?? 0) * units
  }
  const radius = Math.hypot(x - cx, y - cy)
  if (!radius || Math.abs(radius - Math.hypot(to[0] - cx, to[1] - cy)) > Math.max(0.02, radius * 0.0001)) {
    throw new UnsupportedBlock('圆弧的起点与终点半径不匹配。')
  }
  const start = Math.atan2(y - cy, x - cx)
  const finish = Math.atan2(to[1] - cy, to[0] - cx)
  const turn = Math.PI * 2
  const direction = clockwise ? -1 : 1
  const sweep = chord < 1e-9 ? turn : ((direction * (finish - start) % turn) + turn) % turn
  if (sweep === 0) throw new UnsupportedBlock('圆弧角度无效。')
  const step = Math.min(Math.PI / 18, 2 * Math.acos(Math.max(-1, 1 - 0.02 / radius)))
  const count = Math.ceil(sweep / step)
  if (!Number.isFinite(count) || count > 50_000) throw new UnsupportedBlock('圆弧细分超过预览限制。')
  return Array.from({ length: count }, (_, index) => {
    if (index === count - 1) return to
    const fraction = (index + 1) / count
    const angle = start + direction * sweep * fraction
    return [cx + radius * Math.cos(angle), cy + radius * Math.sin(angle), z + (to[2] - z) * fraction]
  })
}

function readBlock(source: string, pointMode: boolean) {
  const text = source.replace(/\([^()]*\)/g, '').split(';', 1)[0].replace(/\s/g, '').toUpperCase()
  const words = new Map<string, number>()
  const g: number[] = []
  const m: number[] = []
  const pattern = /([A-Z])([+-]?(?:\d+(?:\.\d*)?|\.\d+))/gy
  while (pattern.lastIndex < text.length) {
    const match = pattern.exec(text)
    if (!match) throw new UnsupportedBlock('指令格式无法识别。')
    const [, word, raw] = match
    const value = Number(raw)
    if (!Number.isFinite(value) || Math.abs(value) > 1e9) throw new UnsupportedBlock('数值超出预览范围。')
    if (word === 'G') g.push(value)
    else if (word === 'M') m.push(value)
    else {
      // LDS uses Q for laser pulse frequency. It does not affect preview geometry.
      if (!'XYZIJRQFSN'.includes(word) && !(pointMode && word === 'T')) {
        throw new UnsupportedBlock(`不支持字地址 ${word}。`)
      }
      if (words.has(word)) throw new UnsupportedBlock(`重复的字地址 ${word}。`)
      words.set(word, value)
    }
  }
  return { words, g, m }
}

export const pointCommand = /(?:^|[\r\n])[ \t]*(?:N\d+[ \t]*)?G0*25(?![\d.])/i

export function* parseGcodeLines(pointMode: boolean, options: { overview?: boolean; first?: number; last?: number } = {}): Generator<void, PathData, string | null> {
  let positions = new Float32Array(4096 * 6)
  let kinds = new Uint8Array(4096)
  let powers = new Float32Array(4096)
  let lines = new Uint32Array(4096)
  let distances = new Float64Array(4096)
  let size = 0
  let end: XYZ = [0, 0, 0]
  let bounds: PathData['bounds'] = null
  let issue: PathData['issue'] = null
  let absolute = true
  let units = 1
  let motion = 0
  let enabled = false
  let power = 0
  let length = 0
  let line = 0
  let crystal = false
  let curved = false
  let slide = false
  let stride = 1
  let sampledEntries = 0
  let entries = 0
  let limitReached = false
  const first = options.first ?? 1
  const last = options.last ?? Infinity
  const capacityLimit = options.overview ? 500_000 : maxSegments
  let skippedCount = 0
  let firstSkippedLine = 0
  const skippedCodes = new Set<number>()
  let refractiveRate = 1
  let materialAnchor: number | undefined
  let machineFocus: number | undefined
  let pendingHeight: number | undefined
  let cuteng = false
  let loopStart = 0
  let previewedLoops = 0
  let ignoredCount = 0
  const ignoredExamples: { line: number; message: string }[] = []
  const diagnostics = new Map<string, DiagnosticGroup>()
  const otherDiagnostics: DiagnosticGroup = { reason: '其他解析原因', count: 0, firstLine: 0 }

  function recordDiagnostic(line: number, reason: string) {
    let group = diagnostics.get(reason)
    if (!group) {
      group = otherDiagnostics
      if (diagnostics.size < 50) {
        group = { reason, count: 0, firstLine: line }
        diagnostics.set(reason, group)
      }
    }
    if (!group.count) group.firstLine = line
    group.count++
  }

  function recordIgnored(line: number, message: string) {
    ignoredCount++
    if (ignoredExamples.length < 5) ignoredExamples.push({ line, message })
    recordDiagnostic(line, message)
  }

  function materialZ(height: number) {
    const anchor = materialAnchor ?? height
    return anchor + (height - anchor) * refractiveRate
  }

  function previewZ(value: number) {
    const z = value * units
    if (!crystal) return absolute ? z : end[2] + z
    if (!absolute) return end[2] - z * refractiveRate
    if (z < 10) return z
    if (pendingHeight !== undefined) {
      machineFocus = z + pendingHeight
      const height = pendingHeight
      pendingHeight = undefined
      return materialZ(height)
    }
    if (machineFocus === undefined) {
      if (materialAnchor !== undefined) return end[2]
      machineFocus = z
      materialAnchor = 0
    }
    return materialZ(machineFocus - z)
  }

  for (let sourceLine = yield; sourceLine !== null; sourceLine = yield) {
    line++
    if (line > last) break
    const previous: {
      absolute: boolean
      units: number
      motion: number
      enabled: boolean
      power: number
      materialAnchor: number | undefined
      machineFocus: number | undefined
      pendingHeight: number | undefined
    } = { absolute, units, motion, enabled, power, materialAnchor, machineFocus, pendingHeight }
    try {
      const raw = sourceLine.trim()
      if (!raw || raw === '%') continue
      if (raw.startsWith('#')) {
        if (/^#\s*Generated by cuteng\b/i.test(raw)) cuteng = true
        continue
      }
      if (raw.startsWith(':')) continue
      if (cuteng && /^M\s*98\s*L\s*[1-9]\d*\s*(?:;.*)?$/i.test(raw)) {
        if (loopStart) throw new UnsupportedBlock('重复加工块缺少 M99，或包含嵌套循环。')
        loopStart = line
        continue
      }
      if (loopStart && /^M\s*99\s*(?:;.*)?$/i.test(raw)) {
        if (line >= first) previewedLoops++
        loopStart = 0
        continue
      }
      const header = raw.match(/^;gc\s*=\s*(\{.*\})$/i)
      if (header && /"process"\s*:\s*"curved"|"curveBedFromSurface"\s*:\s*true/.test(header[1])) {
        const data = JSON.parse(header[1]) as { process?: string; curveBedFromSurface?: boolean }
        curved ||= data.process === 'curved' || data.curveBedFromSurface === true
      }
      if (header && /"process"\s*:\s*"slide"/.test(header[1])) {
        slide = (JSON.parse(header[1]) as { process?: string }).process === 'slide'
        continue
      }
      if (header && /"process"\s*:\s*"crystal"/.test(header[1])) {
        const data = JSON.parse(header[1]) as { refractiveRate?: number; offset?: { z?: number } }
        if (entries) throw new UnsupportedBlock('水晶坐标文件头必须出现在运动指令之前。')
        crystal = true
        pointMode = true
        if (typeof data.refractiveRate === 'number' && Number.isFinite(data.refractiveRate) && data.refractiveRate > 0) {
          refractiveRate = data.refractiveRate
        }
        const offset = data.offset?.z
        if (typeof offset === 'number' && Number.isFinite(offset)) {
          materialAnchor = offset
          end = [end[0], end[1], offset]
        }
        power = 1000
        continue
      }
      if (crystal && raw.startsWith(';')) {
        const height = raw.match(/^;\s*element\s+\d+\s+absolute-z-start\s+h=([+-]?[\d.]+)/i)
        if (height && Number.isFinite(Number(height[1]))) {
          pendingHeight = Number(height[1])
          materialAnchor ??= pendingHeight
        }
        continue
      }
      const { words, g, m } = readBlock(raw, pointMode)
      if (g.length === 1 && m.length === 0) {
        const parameterCount = words.size - Number(words.has('N'))
        const slideSetup = slide && g[0] === 101 && parameterCount === 1 && (words.get('F') ?? 0) > 0
        const pointWrapper = pointMode && (g[0] === 102 || g[0] === 103) && parameterCount === 0
        if (slideSetup || pointWrapper) {
          if (!skippedCount) firstSkippedLine = line
          skippedCount++
          skippedCodes.add(g[0])
          recordDiagnostic(line, slideSetup
            ? 'G101 设置滑台连续进给。轨迹按程序坐标显示。'
            : 'G102 / G103 是 LDS 点加工控制指令，已从轨迹预览中跳过。')
          continue
        }
      }
      const groups = new Set<string>()
      for (const code of g) {
        let group: string
        if ([0, 1, 2, 3].includes(code) || (pointMode && code === 25)) {
          group = 'motion'
          motion = code
        } else if ([20, 21].includes(code)) {
          group = 'units'
          units = code === 20 ? 25.4 : 1
        } else if ([90, 91].includes(code)) {
          group = 'distance'
          absolute = code === 90
        } else if (code === 17 || code === 91.1 || code === 94) {
          group = String(code)
        } else {
          throw new UnsupportedBlock(`不支持指令 G${code}。`)
        }
        if (groups.has(group)) throw new UnsupportedBlock('同一行包含冲突的 G 指令。')
        groups.add(group)
      }

      if (m.some(code => ![2, 3, 4, 5, 8, 9, 400].includes(code))) {
        throw new UnsupportedBlock(`不支持指令 M${m.find(code => ![2, 3, 4, 5, 8, 9, 400].includes(code))}。`)
      }
      const spindle = m.filter(code => code >= 3 && code <= 5)
      if (spindle.length > 1) throw new UnsupportedBlock('同一行包含冲突的激光指令。')
      if (spindle.length) enabled = spindle[0] !== 5
      const s = words.get('S')
      const hasAxis = ['X', 'Y', 'Z'].some(axis => words.has(axis))
      const hasArc = ['I', 'J', 'R'].some(axis => words.has(axis))
      const isPulse = motion === 25
      const isArc = motion === 2 || motion === 3
      const changesLayer = pointMode && motion === 0 && words.has('Z') && !words.has('X') && !words.has('Y')
      if (words.has('T') && !isPulse && !(crystal && motion === 0)) {
        throw new UnsupportedBlock('此运动不支持脉宽参数 T。')
      }
      const auxiliary = m.length === 1 && m[0] === 8 && !g.length && !hasAxis && !hasArc
      if (m.includes(8) && s !== undefined && !auxiliary) throw new UnsupportedBlock('M8 的 S 参数需要单独成行。')
      if (s !== undefined && !auxiliary) power = Math.max(0, s)

      if (hasAxis || hasArc) {
        if (hasArc && !isArc) throw new UnsupportedBlock('此运动不能使用圆弧参数。')
        const to = ['X', 'Y', 'Z'].map((axis, index) => {
          const value = words.get(axis)
          if (value === undefined) return end[index]
          return index === 2 ? previewZ(value) : value * units + (absolute ? 0 : end[index])
        }) as XYZ
        const points = isArc ? arcPoints(end, to, words, units, motion === 2) : [to]
        if (!options.overview && line >= first && size + points.length > capacityLimit) {
          let count = 0
          let from = end
          for (const next of points) {
            if (isPulse || next.some((value, axis) => value !== from[axis])) count++
            from = next
          }
          if (size + count > capacityLimit) {
            limitReached = true
            issue = { line, message: '路径超过当前预览的两百万段保护上限。' }
            break
          }
        }
        for (const next of points) {
          const step = Math.hypot(next[0] - end[0], next[1] - end[1], next[2] - end[2])
          if (!step && !isPulse) continue
          entries++
          if (line < first) {
            end = next
            continue
          }
          const kind = isPulse ? pulse : changesLayer ? layerChange : motion === 0 ? rapid : enabled && power > 0 ? engraving : travel
          if (kind !== layerChange) {
            const from = isPulse ? next : end
            bounds ??= { min: [...from], max: [...from] }
            for (let axis = 0; axis < 3; axis++) {
              bounds.min[axis] = Math.min(bounds.min[axis], from[axis], next[axis])
              bounds.max[axis] = Math.max(bounds.max[axis], from[axis], next[axis])
            }
          }
          if (options.overview) {
            if (kind === layerChange || sampledEntries++ % stride !== 0) {
              end = next
              continue
            }
          }
          if (size === capacityLimit) {
            stride *= 2
            let write = 0
            for (let read = 0; read < size; read += 2) {
              positions.copyWithin(write * 6, read * 6, read * 6 + 6)
              kinds[write] = kinds[read]
              powers[write] = powers[read]
              lines[write] = lines[read]
              distances[write++] = distances[read]
            }
            size = write
            if ((sampledEntries - 1) % stride !== 0) {
              end = next
              continue
            }
          }
          if (size === kinds.length) {
            const capacity = Math.min(capacityLimit, size * 2)
            const nextPositions = new Float32Array(capacity * 6)
            const nextKinds = new Uint8Array(capacity)
            const nextPowers = new Float32Array(capacity)
            const nextLines = new Uint32Array(capacity)
            const nextDistances = new Float64Array(capacity)
            nextPositions.set(positions)
            nextKinds.set(kinds)
            nextPowers.set(powers)
            nextLines.set(lines)
            nextDistances.set(distances)
            positions = nextPositions
            kinds = nextKinds
            powers = nextPowers
            lines = nextLines
            distances = nextDistances
          }
          // Point jobs advance by operation so repeated pulses still have a position in the timeline.
          length += pointMode ? 1 : step
          positions.set(end, size * 6)
          positions.set(next, size * 6 + 3)
          kinds[size] = kind
          powers[size] = kind === engraving || kind === pulse ? power : 0
          lines[size] = line
          distances[size] = length
          size++
          end = next
        }
      }
      if (m.includes(2)) {
        break
      }
    } catch (error) {
      if (!(error instanceof UnsupportedBlock || error instanceof SyntaxError)) throw error
      ;({ absolute, units, motion, enabled, power, materialAnchor, machineFocus, pendingHeight } = previous)
      recordIgnored(line, error instanceof SyntaxError ? '文件头格式无法识别。' : error.message)
    }
  }

  if (!issue && loopStart && line < last) recordIgnored(loopStart, '重复加工块缺少 M99。')
  return {
    crystal,
    curved,
    pointMode,
    positions: positions.subarray(0, size * 6),
    kinds: kinds.subarray(0, size),
    powers: powers.subarray(0, size),
    lines: lines.subarray(0, size),
    distances: distances.subarray(0, size),
    bounds, end, issue, limitReached,
    previewedLoops: previewedLoops + Number(Boolean(loopStart) && line >= first && line >= last),
    skipped: skippedCount ? { count: skippedCount, firstLine: firstSkippedLine, codes: [...skippedCodes] } : null,
    ignored: ignoredCount ? { count: ignoredCount, examples: ignoredExamples } : null,
    diagnostics: [...diagnostics.values(), ...(otherDiagnostics.count ? [otherDiagnostics] : [])],
  }
}

export function parseGcode(source: string): PathData {
  const parser = parseGcodeLines(pointCommand.test(source))
  let result = parser.next()
  for (const match of source.matchAll(/[^\r\n]*(?:\r\n|\r|\n|$)/g)) {
    if (result.done || !match[0]) break
    result = parser.next(match[0])
  }
  if (!result.done) result = parser.next(null)
  if (!result.done) throw new Error('G-code 解析未完成。')
  return result.value
}

export function distanceAtLine(path: PathData, line: number) {
  // Use the last segment of the line, or the last completed move for non-motion lines.
  let low = 0
  let high = path.lines.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (path.lines[middle] <= line) low = middle + 1
    else high = middle
  }
  return low ? path.distances[low - 1] : 0
}

export function locate(path: PathData, distance: number) {
  const total = path.distances.at(-1) ?? 0
  if (!total) return null
  const target = Math.min(total, Math.max(0, distance))
  let low = 0
  let high = path.distances.length - 1
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (path.distances[middle] < target) low = middle + 1
    else high = middle
  }
  const start = path.distances[low - 1] ?? 0
  const fraction = path.kinds[low] === pulse
    ? Number(target === path.distances[low])
    : (target - start) / (path.distances[low] - start)
  const offset = low * 6
  const position = [0, 1, 2].map(axis => {
    const from = path.positions[offset + axis]
    return from + (path.positions[offset + axis + 3] - from) * fraction
  }) as XYZ
  return { index: low, line: path.lines[low], position }
}
