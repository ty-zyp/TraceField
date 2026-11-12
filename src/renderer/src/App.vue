<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import traceFieldLogo from '../../../tracefield-logo.png'
import {
  fileExtension,
  fileExtensions,
  gcodeExtensions,
  isFileSizeAllowed,
  readFileBytes,
  type DiskFile,
} from '../../shared/files'
import { maxDetailLines, readSourcePage, type GcodeLineRange, type GcodeSourceIndex } from '../../shared/gcodeFile'
import { distanceAtLine, engraving, locate, pulse, type PathData, type XYZ } from '../../shared/gcode'
import GcodeWorker from './gcode.worker?worker&inline'
import { disposeObject, Viewport, type ViewMode, type ViewOrientation } from './viewport'
import ViewCube from './ViewCube.vue'
import { loadModel, setPointSize } from './models'
import type { PointAppearance, PointHeight } from './pointAppearance'

const host = ref<HTMLElement>()
const sourcePane = ref<HTMLElement>()
const fileInput = ref<HTMLInputElement>()
const referenceInput = ref<HTMLInputElement>()
const referenceExtensions = ['ply', 'pcd', 'glb']
const reference = shallowRef<{ name: string; bounds: { min: XYZ; max: XYZ } }>()
const referenceLoading = ref(false)
const referenceError = ref('')
const referenceTransparency = ref(55)
const referenceVisible = ref(true)
const pathVisible = ref(true)
const path = shallowRef<PathData>()
const model = shallowRef<Awaited<ReturnType<typeof loadModel>>>()
const indexedSource = shallowRef<{ file: File | DiskFile; index: GcodeSourceIndex }>()
const currentFile = shallowRef<File>()
const reloading = ref(false)
const sourcePage = shallowRef<{ first: number; lines: string[] }>()
const overviewPath = shallowRef<PathData>()
const overview = ref(false)
const detailFirst = ref<number | string>(1)
const detailSize = ref<number | string>(maxDetailLines)
type DetailDirection = -1 | 0 | 1
const loadingDirection = ref<DetailDirection | null>(null)
const detailLoading = computed(() => loadingDirection.value !== null)
const detailProgress = shallowRef<{ first: number; last: number; processed: number }>()
const activeDetail = shallowRef<GcodeLineRange>()
const loadedStarts = new Map<number, number>()
const name = ref('')
const busy = ref(false)
const error = ref('')
const viewportError = ref('')
const dragging = ref(0)
const mode = ref<ViewMode>('top')
const orientation = shallowRef<ViewOrientation>()
const distance = ref(0)
const selectedLine = ref<number>()
const reportLine = ref<number>()
const reportText = ref('')
const speed = ref(1)
const playing = ref(false)
const hideTravel = ref(false)
const grayscale = ref(false)
const pointSize = ref(2)
const pointAppearance = ref<PointAppearance>('original')
const pointColor = ref('#e5b85c')
const pathPointHeight = shallowRef<PointHeight | null>(null)
const pointHeight = computed(() => model.value?.height ?? pathPointHeight.value)
const pointSlice = shallowRef<PointHeight | null>(null)
const vertexView = ref(false)
type InspectedPoint = { position: XYZ; world: XYZ }
const inspectionMode = ref<'point' | 'distance'>()
const inspectedPoints = shallowRef<InspectedPoint[]>([])
const copyStatus = ref('')
const measurement = computed(() => {
  const [a, b] = inspectedPoints.value
  if (!a || !b) return null
  const delta = b.position.map((value, axis) => value - a.position[axis]) as XYZ
  return { delta, distance: Math.hypot(...delta) }
})
const hoveredPath = shallowRef<{ index: number; x: number; y: number }>()
const hoveredLine = computed(() => hoveredPath.value && path.value?.lines[hoveredPath.value.index])
const hoveredKind = computed(() => hoveredPath.value && path.value?.kinds[hoveredPath.value.index])
const scrollTop = ref(0)
const sourceHeight = ref(600)
const rowHeight = 23
const sliderSteps = 10_000
const total = computed(() => path.value?.distances.at(-1) ?? 0)
const sliderValue = computed(() => total.value ? Math.round(distance.value / total.value * sliderSteps) : 0)
const cursor = computed(() => path.value && locate(path.value, distance.value))
const activeLine = computed(() => reportLine.value ?? selectedLine.value ?? path.value?.issue?.line ?? cursor.value?.line)
const reportCount = computed(() => (path.value?.skipped?.count ?? 0) + (path.value?.ignored?.count ?? 0))
const position = computed(() => {
  if (overview.value) return null
  if (path.value?.issue && selectedLine.value === undefined) return null
  return cursor.value?.position ?? (selectedLine.value === undefined ? null : path.value?.end)
})
const sourceCount = computed(() => indexedSource.value?.index.lineCount ?? 0)
const validDetailSize = computed(() => Number.isInteger(detailSize.value)
  && Number(detailSize.value) >= 1 && Number(detailSize.value) <= maxDetailLines)
const detailLast = computed(() => {
  const first = Number(detailFirst.value)
  return validDetailSize.value && Number.isInteger(first) && first >= 1 && first <= sourceCount.value
    ? Math.min(sourceCount.value, first + Number(detailSize.value) - 1)
    : null
})
const detailActions = computed(() => {
  const range = activeDetail.value
  const sizeHint = validDetailSize.value ? '' : '请输入有效的单次加载行数'
  return [
    { direction: 0 as const, label: '加载行区间', unavailable: detailLast.value === null ? '请输入有效的起始行和加载行数' : '' },
    { direction: -1 as const, label: '加载上一段', unavailable: !range ? '请先加载一个行区间' : range.first <= 1 ? '已到文件开头' : sizeHint },
    { direction: 1 as const, label: '加载下一段', unavailable: !range ? '请先加载一个行区间' : range.last >= sourceCount.value ? '已到文件末尾' : sizeHint },
  ]
})
const sourcePixels = computed(() => sourceCount.value * rowHeight)
const scrollPixels = computed(() => Math.min(8_000_000, sourcePixels.value))
const scrollScale = computed(() => {
  const viewport = sourceHeight.value
  return Math.max(1, (sourcePixels.value - viewport) / Math.max(1, scrollPixels.value - viewport))
})
const firstRow = computed(() => Math.max(0, Math.floor(scrollTop.value * scrollScale.value / rowHeight) - 10))
const rowsOffset = computed(() => scrollTop.value + firstRow.value * rowHeight - scrollTop.value * scrollScale.value)
const visibleCount = computed(() => Math.max(0, Math.min(sourceCount.value - firstRow.value, Math.ceil(sourceHeight.value / rowHeight) + 20)))
const visibleRows = computed(() => Array.from({ length: visibleCount.value }, (_, i) => sourceText(firstRow.value + i)))
const speeds = [0.25, 0.5, 1, 2, 4, 8]
let viewport: Viewport | undefined
let pendingFile: File | DiskFile | undefined
let referenceJob: AbortController | undefined
let modelFile: File | undefined
let paneObserver: ResizeObserver | undefined
let job: AbortController | undefined
let detailJob: AbortController | undefined
let frame = 0
let lastTime = 0
let hoverTimer: ReturnType<typeof setTimeout> | undefined
let pressPosition: [number, number] | undefined

function sourceText(row: number) {
  return sourcePage.value?.lines[row - sourcePage.value.first] ?? ''
}

watch([reportLine, sourcePage], ([line, page], [previousLine]) => {
  if (line !== previousLine) reportText.value = ''
  if (line === undefined || !page) return
  const text = page.lines[line - 1 - page.first]
  if (text !== undefined) reportText.value = text
})

watch([indexedSource, firstRow, visibleCount], async ([source, row, count], _, onCleanup) => {
  if (!source || !count) return
  const page = sourcePage.value
  if (page && row >= page.first && row + count <= page.first + page.lines.length) return
  let cancelled = false
  onCleanup(() => { cancelled = true })
  try {
    const loaded = await readSourcePage(source.file, source.index, row)
    if (!cancelled) sourcePage.value = loaded
  } catch {
    if (!cancelled) error.value = '无法读取这段源码。'
  }
})

function parseFile(file: File | DiskFile, signal: AbortSignal, index?: GcodeSourceIndex, range?: GcodeLineRange,
  onProgress?: (processedLines: number) => void):
  Promise<{ sourceIndex: GcodeSourceIndex; path: PathData; overview: boolean; loadedRange?: GcodeLineRange }> {
  return new Promise((resolve, reject) => {
    const worker = new GcodeWorker()
    function finish() {
      worker.terminate()
      signal.removeEventListener('abort', abort)
    }
    function abort() {
      finish()
      reject(new DOMException('Aborted', 'AbortError'))
    }
    signal.addEventListener('abort', abort, { once: true })
    worker.onmessage = ({ data }) => {
      if (typeof data.progress === 'number') {
        onProgress?.(data.progress)
        return
      }
      finish()
      if (data.error) reject(new Error(data.error))
      else resolve(data)
    }
    worker.onerror = (event) => {
      finish()
      reject(new Error(event.message || '无法启动 G-code 解析。'))
    }
    worker.postMessage({ file, index, range })
  })
}

function followSource() {
  const pane = sourcePane.value
  const line = activeLine.value
  if (!pane || !line) return
  const top = (line - 1) * rowHeight
  const logicalTop = pane.scrollTop * scrollScale.value
  if (top < logicalTop || top + rowHeight > logicalTop + pane.clientHeight) {
    pane.scrollTop = Math.max(0, (top - pane.clientHeight / 3) / scrollScale.value)
    scrollTop.value = pane.scrollTop
  }
}

function seek(value: number, line?: number) {
  clearPathHover()
  reportLine.value = undefined
  selectedLine.value = line
  distance.value = Math.min(total.value, Math.max(0, value))
  const index = cursor.value?.index
  const progress = path.value && total.value && position.value && index !== undefined
    ? {
        ratio: distance.value / total.value,
        segments: distance.value > 0 ? index + 1 : 0,
        completed: index + Number(distance.value >= path.value.distances[index]),
      }
    : null
  viewport?.setCursor(position.value ?? null, progress, line !== undefined)
  followSource()
}

function showReportLine(line: number) {
  pause()
  reportLine.value = line
  followSource()
}

function clearPathHover() {
  clearTimeout(hoverTimer)
  hoveredPath.value = undefined
}

function hoverPath(event: PointerEvent) {
  clearPathHover()
  if (pressPosition && Math.hypot(event.clientX - pressPosition[0], event.clientY - pressPosition[1]) > 4) {
    pressPosition = undefined
  }
  if (!path.value || inspectionMode.value || playing.value || event.buttons || event.pointerType === 'touch') return
  const { clientX, clientY } = event
  const rect = host.value!.getBoundingClientRect()
  hoverTimer = setTimeout(() => {
    const index = viewport?.pickPath(clientX, clientY)
    if (index == null) return
    hoveredPath.value = {
      index,
      x: Math.max(0, Math.min(clientX - rect.left + 14, rect.width - 235)),
      y: Math.max(0, Math.min(clientY - rect.top + 14, rect.height - 78)),
    }
  }, 120)
}

function pickPath(event: PointerEvent) {
  const start = pressPosition
  pressPosition = undefined
  if (!start || event.button !== 0) return
  if (Math.hypot(event.clientX - start[0], event.clientY - start[1]) > 4) return
  if (inspectionMode.value) {
    inspectPoint(event.clientX, event.clientY)
    return
  }
  if (!path.value) return
  const index = viewport?.pickPath(event.clientX, event.clientY)
  if (index != null) seekToLine(path.value.lines[index])
}

function setInspectedPoints(points: InspectedPoint[]) {
  inspectedPoints.value = points
  copyStatus.value = ''
  viewport?.showInspection(points.map(point => point.world))
}

function togglePointSlice() {
  if (!pointHeight.value) return
  pointSlice.value = pointSlice.value ? null : [...pointHeight.value]
  viewport?.setPointSlice(pointSlice.value)
}

function changeSliceBound(axis: 0 | 1, event: Event) {
  const input = event.target as HTMLInputElement
  if (!pointHeight.value || !pointSlice.value) return
  const [min, max] = pointSlice.value
  const [fullMin, fullMax] = pointHeight.value
  const value = input.valueAsNumber
  if (!Number.isFinite(value)) {
    input.value = String(pointSlice.value[axis])
    return
  }
  const range: PointHeight = axis === 0
    ? [Math.max(fullMin, Math.min(max, value)), max]
    : [min, Math.min(fullMax, Math.max(min, value))]
  input.value = String(range[axis])
  pointSlice.value = range
  clearPathHover()
  viewport?.setPointSlice(range)
  if (inspectedPoints.value.some(({ world }) => world[2] < range[0] || world[2] > range[1])) {
    setInspectedPoints([])
  }
}

function toggleInspection(value: 'point' | 'distance') {
  inspectionMode.value = inspectionMode.value === value ? undefined : value
  if (inspectionMode.value) pause()
  clearPathHover()
  setInspectedPoints([])
}

function inspectPoint(x: number, y: number) {
  let point: InspectedPoint | undefined
  if (path.value) {
    const index = viewport?.pickPath(x, y, true)
    if (index == null || path.value.kinds[index] !== pulse) return
    const offset = index * 6 + 3
    const position = Array.from(path.value.positions.subarray(offset, offset + 3)) as XYZ
    point = { position, world: [position[0], -position[1], position[2]] }
  } else {
    const position = viewport?.pickModelPoint(x, y)
    if (position) point = { position, world: position }
  }
  if (!point) return
  const previous = inspectedPoints.value
  setInspectedPoints(inspectionMode.value === 'distance' && previous.length === 1 ? [previous[0], point] : [point])
}

function useRotationCenter(point: InspectedPoint) {
  viewport?.setRotationCenter(point.world)
  mode.value = 'orbit'
}

async function copyPoint(point: InspectedPoint) {
  try {
    await navigator.clipboard.writeText(point.position.map(value => Number(value.toFixed(6))).join(', '))
    if (inspectedPoints.value.includes(point)) copyStatus.value = '坐标已复制'
  } catch {
    if (inspectedPoints.value.includes(point)) copyStatus.value = '复制失败，可选择坐标文字复制'
  }
}

function formatCoordinates(position: XYZ, prefix = '') {
  return ['X', 'Y', 'Z'].map((axis, index) => prefix + axis + ' ' + position[index].toFixed(3)).join('  ')
}

function seekToLine(line: number) {
  const currentPath = path.value
  if (!currentPath || (currentPath.issue && line >= currentPath.issue.line)) return
  if (activeDetail.value && (line < activeDetail.value.first || line > activeDetail.value.last)) return
  pause()
  if (overview.value) {
    selectedLine.value = line
    detailFirst.value = line
    followSource()
    return
  }
  seek(distanceAtLine(currentPath, line), line)
}

function pause() {
  playing.value = false
  cancelAnimationFrame(frame)
  lastTime = 0
}

function tick(time: number) {
  if (!playing.value) return
  if (lastTime) seek(distance.value + Math.min(100, time - lastTime) * total.value * speed.value / 15_000)
  lastTime = time
  if (distance.value >= total.value) pause()
  else frame = requestAnimationFrame(tick)
}

function togglePlayback() {
  if (playing.value) return pause()
  if (!total.value || path.value?.issue || overview.value) return
  seek(distance.value >= total.value ? 0 : distance.value)
  playing.value = true
  frame = requestAnimationFrame(tick)
}

function setMode(value: ViewMode) {
  clearPathHover()
  mode.value = value
  viewport?.setMode(value)
}

function lookFrom(direction: XYZ) {
  if (viewport) mode.value = viewport.lookFrom(direction)
}

function resetView() {
  setMode(model.value || path.value?.pointMode ? 'orbit' : 'top')
}

async function open(file: File | DiskFile, asPoints = false, remember = false) {
  const extension = fileExtension(file.name)
  const isGcode = gcodeExtensions.includes(extension)
  if (!fileExtensions.includes(extension) || !isFileSizeAllowed(extension, file.size)) {
    error.value = '请选择受支持的非空文件。G-code 上限为 1 GiB，三维模型上限为 512 MiB。'
    return
  }
  if (remember && file instanceof File) currentFile.value = file
  if (!initializeViewport()) {
    pendingFile = file
    name.value = file.name
    return
  }
  pendingFile = undefined
  removeReference()
  modelFile = undefined
  vertexView.value = false
  pointSlice.value = null
  clearPathHover()
  inspectionMode.value = undefined
  setInspectedPoints([])
  job?.abort()
  detailJob?.abort()
  detailJob = undefined
  loadingDirection.value = null
  detailProgress.value = undefined
  const controller = new AbortController()
  job = controller
  pause()
  viewport?.clear()
  paneObserver?.disconnect()
  path.value = undefined
  reportLine.value = undefined
  pathPointHeight.value = null
  model.value = undefined
  indexedSource.value = undefined
  sourcePage.value = undefined
  overviewPath.value = undefined
  overview.value = false
  activeDetail.value = undefined
  loadedStarts.clear()
  scrollTop.value = 0
  distance.value = 0
  selectedLine.value = undefined
  name.value = file.name
  error.value = ''
  busy.value = true
  try {
    if (isGcode) {
      const parsed = await parseFile(file, controller.signal)
      if (controller.signal.aborted) return
      indexedSource.value = { file, index: parsed.sourceIndex }
      overview.value = parsed.overview
      overviewPath.value = parsed.overview ? parsed.path : undefined
      detailFirst.value = 1
      detailSize.value = maxDetailLines
      showParsedPath(parsed.path)
      await nextTick()
      if (controller.signal.aborted) return
      const pane = sourcePane.value
      if (pane) {
        paneObserver = new ResizeObserver(() => { sourceHeight.value = pane.clientHeight })
        paneObserver.observe(pane)
        followSource()
      }
    } else {
      const modelSource = file instanceof File ? file : new File([await readFileBytes(file, 0, file.size, controller.signal)], file.name)
      const loaded = await loadModel(modelSource, extension, asPoints)
      if (controller.signal.aborted || !viewport) {
        disposeObject(loaded.root)
        return
      }
      model.value = loaded
      modelFile = loaded.meshes && !loaded.points || asPoints ? modelSource : undefined
      vertexView.value = asPoints
      mode.value = 'orbit'
      setPointSize(loaded.root, pointSize.value)
      viewport.showModel(loaded.root, loaded.slice)
      updatePointAppearance()
    }
  } catch (failure) {
    if (!controller.signal.aborted) error.value = (failure as Error).message
  } finally {
    if (!controller.signal.aborted) busy.value = false
  }
}

function showParsedPath(data: PathData, keepReference = false) {
  path.value = data
  reportLine.value = undefined
  selectedLine.value = undefined
  distance.value = 0
  pointSlice.value = null
  inspectionMode.value = undefined
  setInspectedPoints([])
  mode.value = data.pointMode ? 'orbit' : 'top'
  pathPointHeight.value = viewport?.showPath(data, keepReference) ?? null
  viewport?.setPathVisible(pathVisible.value)
  viewport?.setHideTravel(hideTravel.value)
  viewport?.setGrayscale(grayscale.value)
  updatePointAppearance()
  viewport?.setCursor(position.value ?? null, null)
}

async function loadDetail(direction: DetailDirection = 0) {
  const source = indexedSource.value
  if (!source || detailLoading.value) return
  const current = activeDetail.value
  const size = Number(detailSize.value)
  let first = Number(detailFirst.value)
  let last = detailLast.value
  if (validDetailSize.value && current && direction === 1) {
    first = current.last + 1
    last = Math.min(source.index.lineCount, first + size - 1)
  } else if (validDetailSize.value && current && direction === -1) {
    last = current.first - 1
    first = Math.max(1, last - size + 1, loadedStarts.get(last) ?? 1)
  }
  if (!validDetailSize.value || last === null || first < 1 || last < first) {
    error.value = `请输入有效的起始行，单次加载行数须为 1 至 ${maxDetailLines.toLocaleString()}。`
    return
  }
  const controller = new AbortController()
  detailJob = controller
  loadingDirection.value = direction
  detailProgress.value = { first, last, processed: 0 }
  error.value = ''
  pause()
  clearPathHover()
  try {
    const parsed = await parseFile(source.file, controller.signal, source.index, { first, last }, processed => {
      if (detailJob === controller && !controller.signal.aborted) detailProgress.value = { first, last, processed }
    })
    if (controller.signal.aborted) return
    if (parsed.path.issue || !parsed.loadedRange) {
      error.value = parsed.path.issue
        ? `第 ${parsed.path.issue.line} 行 · ${parsed.path.issue.message}`
        : '无法加载所选区间。'
      return
    }
    overview.value = false
    activeDetail.value = parsed.loadedRange
    loadedStarts.set(parsed.loadedRange.last, parsed.loadedRange.first)
    detailFirst.value = parsed.loadedRange.first
    showParsedPath(parsed.path, true)
    selectedLine.value = parsed.loadedRange.first
    followSource()
  } catch (failure) {
    if (!controller.signal.aborted) error.value = (failure as Error).message
  } finally {
    if (detailJob === controller) {
      detailJob = undefined
      loadingDirection.value = null
      detailProgress.value = undefined
    }
  }
}

function cancelDetailLoad() {
  detailJob?.abort()
}

function returnToOverview() {
  if (!overviewPath.value) return
  pause()
  clearPathHover()
  overview.value = true
  activeDetail.value = undefined
  showParsedPath(overviewPath.value, true)
  followSource()
}

function removeReference() {
  referenceJob?.abort()
  referenceJob = undefined
  reference.value = undefined
  referenceLoading.value = false
  referenceError.value = ''
  pathVisible.value = true
  viewport?.clearReference()
  viewport?.setPathVisible(true)
}

async function openReference(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file || !path.value || !viewport) return
  const extension = fileExtension(file.name)
  if (!referenceExtensions.includes(extension) || !isFileSizeAllowed(extension, file.size)) {
    referenceError.value = '请选择 512 MiB 以内的 PLY、PCD 或 GLB 文件。'
    return
  }
  referenceJob?.abort()
  const controller = new AbortController()
  referenceJob = controller
  referenceLoading.value = true
  referenceError.value = ''
  try {
    const loaded = await loadModel(file, extension)
    if (controller.signal.aborted) {
      disposeObject(loaded.root)
      return
    }
    setPointSize(loaded.root, pointSize.value)
    viewport.showReference(loaded.root, referenceVisible.value, 1 - referenceTransparency.value / 100)
    reference.value = { name: file.name, bounds: { min: loaded.bounds.min.toArray(), max: loaded.bounds.max.toArray() } }
  } catch (failure) {
    if (!controller.signal.aborted) referenceError.value = (failure as Error).message
  } finally {
    if (!controller.signal.aborted) referenceLoading.value = false
  }
}

function updateReferenceDisplay() {
  viewport?.setReferenceDisplay(referenceVisible.value, 1 - referenceTransparency.value / 100)
}

function formatBounds(bounds: { min: XYZ; max: XYZ }) {
  return ['X', 'Y', 'Z'].map((axis, index) =>
    axis + ' ' + bounds.min[index].toFixed(3) + ' ～ ' + bounds.max[index].toFixed(3)).join('   ')
}

function toggleVertexView() {
  if (modelFile) void open(modelFile, !vertexView.value)
}

function choose() {
  fileInput.value?.click()
}

async function reloadCurrentFile() {
  const file = currentFile.value
  if (!file || busy.value || reloading.value) return
  reloading.value = true
  error.value = ''
  try {
    const fresh = await window.viewer?.reloadFile(file)
    if (file !== currentFile.value) return
    if (!fresh) throw new Error('无法定位原文件，请使用「打开文件」重新选择。')
    await open(fresh, vertexView.value)
  } catch (failure) {
    if (file === currentFile.value) error.value = (failure as Error).message
  } finally {
    reloading.value = false
  }
}

function drop(event: DragEvent) {
  dragging.value = 0
  const file = event.dataTransfer?.files[0]
  if (file) void open(file, false, true)
}

function updatePointSize() {
  if (model.value) setPointSize(model.value.root, pointSize.value)
  viewport?.refresh()
}

function updatePointAppearance() {
  if (model.value) {
    model.value.setAppearance(pointAppearance.value, pointColor.value)
    viewport?.refresh()
  } else {
    viewport?.setPointAppearance(pointAppearance.value, pointColor.value)
  }
}

function initializeViewport() {
  if (viewport) return true
  try {
    viewport = new Viewport(host.value!, value => { orientation.value = value }, (lost) => {
      if (lost) pause()
      viewportError.value = lost ? 'WebGL 连接已中断，正在等待恢复。' : ''
    })
    viewportError.value = ''
    return true
  } catch (failure) {
    console.error('Failed to initialize the preview viewport.', failure)
    viewportError.value = '无法创建 WebGL 2 视口。'
    return false
  }
}

function retryViewport() {
  if (initializeViewport() && pendingFile) void open(pendingFile)
}

onMounted(initializeViewport)
onBeforeUnmount(() => {
  clearPathHover()
  referenceJob?.abort()
  job?.abort()
  detailJob?.abort()
  pause()
  paneObserver?.disconnect()
  viewport?.dispose()
})
</script>

<template>
  <div class="app" @dragenter.prevent="dragging++" @dragleave.prevent="dragging = Math.max(0, dragging - 1)" @dragover.prevent @drop.prevent="drop">
    <header class="toolbar">
      <img class="brand-mark" :src="traceFieldLogo" alt="" />
      <div class="brand"><strong>迹域 · TraceField</strong><span>激光路径与三维文件查看器</span></div>
      <span class="toolbar-divider"></span>
      <button class="open-button" @click="choose">打开文件</button>
      <input ref="fileInput" hidden type="file" :accept="fileExtensions.map(ext => '.' + ext).join(',')" @change="event => { const input = event.target as HTMLInputElement; const file = input.files?.[0]; if (file) open(file, false, true); input.value = '' }" />
      <span v-if="name" class="filename" :title="name">{{ name }}</span>
      <button v-if="currentFile" class="reload-button" type="button" :disabled="busy || reloading" @click="reloadCurrentFile">重新加载</button>
      <span class="offline"><i></i> 本地预览</span>
    </header>

    <div v-if="error || viewportError || path?.issue" class="alert" role="alert">
      {{ viewportError || error || ('第 ' + path?.issue?.line + ' 行 · ' + path?.issue?.message + (path?.kinds.length ? ' 已保留此前的路径。' : ' 解析在首段运动前停止。')) }}
      <button v-if="viewportError && !viewport" type="button" @click="retryViewport">重试初始化</button>
    </div>
    <details v-if="path?.diagnostics.length" class="alert parse-report">
      <summary>解析报告 · 已跳过 {{ reportCount.toLocaleString() }} 行<span v-if="path.ignored">，后续轨迹可能与实际加工不同</span></summary>
      <div class="parse-report-body">
        <p v-if="activeDetail">报告含恢复坐标模式时解析的区间前源码。</p>
        <div v-for="group in path.diagnostics" :key="group.reason" class="parse-report-group">
          <strong>{{ group.reason }}</strong>
          <span>{{ group.count.toLocaleString() }} 行</span>
          <button type="button" :aria-pressed="reportLine === group.firstLine"
            @click="showReportLine(group.firstLine)">第 {{ group.firstLine.toLocaleString() }} 行</button>
        </div>
      </div>
      <div v-if="reportLine" class="parse-report-source">
        <span>第 {{ reportLine.toLocaleString() }} 行</span><code>{{ reportText }}</code>
      </div>
    </details>
    <div v-if="path?.previewedLoops" class="alert" role="status">
      {{ path.previewedLoops }} 组 LDS 重复加工块各预览一遍，播放进度按预览轨迹计算。
    </div>
    <div v-if="path?.curved" class="alert" role="status">
      曲面文件按程序坐标预览，Z 值未换算为材料表面高度。
    </div>

    <main class="workspace">
      <aside v-if="path" class="source">
        <div class="panel-heading"><span>程序源码</span><small>{{ sourceCount.toLocaleString() }} 行</small></div>
        <div ref="sourcePane" class="source-scroll" aria-label="程序源码" tabindex="0" @scroll="scrollTop = ($event.target as HTMLElement).scrollTop">
          <div class="source-track" :style="{ height: scrollPixels + 'px' }">
            <div class="source-window" :style="{ top: rowsOffset + 'px' }">
              <button v-for="(text, index) in visibleRows" :key="firstRow + index" type="button" class="source-row"
                :class="{ active: firstRow + index + 1 === activeLine, invalid: firstRow + index + 1 === path.issue?.line }"
                :aria-current="firstRow + index + 1 === activeLine ? 'true' : undefined"
                :disabled="(!!path.issue && firstRow + index + 1 >= path.issue.line) || (!!activeDetail && (firstRow + index + 1 < activeDetail.first || firstRow + index + 1 > activeDetail.last))"
                @click="seekToLine(firstRow + index + 1)">
                <span>{{ firstRow + index + 1 }}</span><code>{{ text }}</code>
              </button>
            </div>
          </div>
        </div>
      </aside>
      <section class="preview">
        <div class="panel-heading viewport-heading">
          <span>{{ path ? '路径视图' : model ? '三维视图' : '预览视口' }}</span>
          <div class="view-tools">
            <button :class="{ selected: mode === 'top' }" :aria-pressed="mode === 'top'" @click="setMode('top')">XY 顶视</button>
            <button :class="{ selected: mode === 'orbit' }" :aria-pressed="mode === 'orbit'" @click="setMode('orbit')">三维</button>
            <button @click="viewport?.fit(true)">适配窗口</button>
            <button v-if="path" type="button" :disabled="referenceLoading" @click="referenceInput?.click()">{{ reference ? '更换参考模型' : '添加参考模型' }}</button>
            <input ref="referenceInput" hidden type="file" accept=".ply,.pcd,.glb" @change="openReference" />
            <button v-if="path" :class="{ selected: grayscale }" :aria-pressed="grayscale" title="用灰度显示 G-code 的相对 S 功率，当前轨迹的最高功率显示为白色。适合查看变功率雕刻。" @click="grayscale = !grayscale; viewport?.setGrayscale(grayscale)">功率灰度</button>
          </div>
        </div>
        <div v-if="overviewPath" class="reference-panel">
          <div>{{ overview ? '大文件概览 · 抽样显示' : '已加载第 ' + activeDetail?.first.toLocaleString() + ' 至 ' + activeDetail?.last.toLocaleString() + ' 行' }}
            <span v-if="activeDetail && path?.limitReached"> · 已达到轨迹段上限，下一段从紧接的一行继续</span>
          </div>
          <div class="reference-controls">
            <label>起始行 <input v-model.number="detailFirst" type="number" min="1" :max="sourceCount" :disabled="detailLoading" /></label>
            <label>单次加载行数 <input v-model.number="detailSize" type="number" min="1" :max="maxDetailLines" :disabled="detailLoading" /></label>
            <span>结束行 {{ detailLast?.toLocaleString() ?? '—' }}</span>
            <span v-for="action in detailActions" :key="action.direction" class="detail-action"
              :class="{ unavailable: action.unavailable, waiting: detailLoading && !action.unavailable }"
              :title="action.unavailable || (detailLoading ? '正在加载行区间' : undefined)">
              <button type="button" :disabled="detailLoading || !!action.unavailable"
                :aria-busy="loadingDirection === action.direction ? 'true' : undefined" @click="loadDetail(action.direction)">
                <span v-if="loadingDirection === action.direction" class="spinner" aria-hidden="true"></span>{{ action.label }}
              </button>
            </span>
            <button v-if="!overview" type="button" :disabled="detailLoading" @click="returnToOverview">返回概览</button>
          </div>
          <div v-if="detailProgress" class="reference-controls detail-progress">
            <span>{{ detailProgress.processed + 1 < detailProgress.first ? '正在读取区间前的指令' : '正在解析所选区间' }}</span>
            <progress :value="detailProgress.processed" :max="detailProgress.last" aria-label="区间加载进度"></progress>
            <span>{{ Math.min(99, Math.floor(detailProgress.processed / detailProgress.last * 100)) }}%</span>
            <button type="button" @click="cancelDetailLoad">取消加载</button>
          </div>
        </div>
        <div v-if="reference || referenceLoading || referenceError" class="reference-panel">
          <div v-if="reference" class="reference-controls">
            <strong :title="reference.name">{{ reference.name }}</strong>
            <label><input v-model="pathVisible" type="checkbox" @change="clearPathHover(); viewport?.setPathVisible(pathVisible)" /> 显示路径</label>
            <label><input v-model="referenceVisible" type="checkbox" @change="updateReferenceDisplay" /> 显示模型</label>
            <label>模型透明度 <input v-model.number="referenceTransparency" type="range" min="0" max="100" aria-label="参考模型透明度" @input="updateReferenceDisplay" /> {{ referenceTransparency }}%</label>
            <button type="button" @click="removeReference">移除模型</button>
          </div>
          <div v-if="reference" class="reference-bounds">
            <div v-if="path?.bounds"><span>路径（mm）</span><code>{{ formatBounds(path.bounds) }}</code></div>
            <div><span>模型（文件单位）</span><code>{{ formatBounds(reference.bounds) }}</code></div>
          </div>
          <span v-if="referenceLoading" role="status">正在加载参考模型</span>
          <span v-if="referenceError" role="alert">{{ referenceError }}</span>
        </div>
        <div class="canvas-wrap">
          <div ref="host" class="canvas" :class="{ 'point-inspection-active': inspectionMode }" @pointerdown="pressPosition = $event.button === 0 ? [$event.clientX, $event.clientY] : undefined"
            @pointerup="pickPath" @pointermove="hoverPath" @pointerleave="clearPathHover" @pointercancel="pressPosition = undefined" @wheel="clearPathHover"></div>
          <div v-if="hoveredPath && hoveredLine && path" class="path-hover" :style="{ left: hoveredPath.x + 'px', top: hoveredPath.y + 'px' }">
            <div>第 {{ hoveredLine }} 行<span v-if="hoveredKind === engraving || hoveredKind === pulse"> · S {{ path.powers[hoveredPath.index] }}</span></div>
            <code>{{ sourceText(hoveredLine - 1) }}</code>
            <div>{{ hoveredKind === pulse ? '点位' : '终点' }} {{ ['X', 'Y', 'Z'].map((axis, index) => axis + ' ' + path!.positions[hoveredPath!.index * 6 + 3 + index].toFixed(3)).join('  ') }}</div>
          </div>
          <div v-if="pointHeight || model?.meshes" class="point-appearance">
            <label>
              点云着色
              <select v-model="pointAppearance" :disabled="!pointHeight" @change="updatePointAppearance">
                <option value="original">{{ path ? '原有着色' : '原始颜色' }}</option>
                <option value="white">纯白</option>
                <option value="solid">自定义单色</option>
                <option value="height">按 Z 高度</option>
              </select>
            </label>
            <input v-if="pointHeight && pointAppearance === 'solid'" v-model="pointColor" type="color" aria-label="点云颜色" @input="updatePointAppearance" />
            <button type="button" :disabled="!pointHeight || overview" :aria-pressed="inspectionMode === 'point'" @click="toggleInspection('point')">查坐标</button>
            <button type="button" :disabled="!pointHeight || overview" :aria-pressed="inspectionMode === 'distance'" @click="toggleInspection('distance')">测距</button>
            <button v-if="pointHeight" type="button" :aria-pressed="!!pointSlice" @click="togglePointSlice">Z 切片</button>
            <button v-if="vertexView || (model?.meshes && !model.points)" type="button" @click="toggleVertexView">{{ vertexView ? '返回网格' : '查看顶点' }}</button>
            <small v-if="!pointHeight" class="point-tools-note">切换到顶点视图后可使用点云工具</small>
            <div v-if="pointSlice && pointHeight" class="point-slice">
              <div v-for="(label, index) in ['Z 下限', 'Z 上限']" :key="label" class="slice-bound">
                <span>{{ label }}</span>
                <input type="number" step="any" :min="pointHeight[0]" :max="pointHeight[1]" :value="pointSlice[index]"
                  :aria-label="label" @change="changeSliceBound(index === 0 ? 0 : 1, $event)" />
                <input type="range" step="any" :min="pointHeight[0]" :max="pointHeight[1]" :value="pointSlice[index]"
                  :disabled="pointHeight[0] === pointHeight[1]" :aria-label="label + '滑块'" @input="changeSliceBound(index === 0 ? 0 : 1, $event)" />
              </div>
            </div>
            <div v-if="pointHeight && pointAppearance === 'height'" class="point-height-scale" aria-label="Z 高度色标">
              <div></div>
              <span>{{ pointHeight[0].toFixed(3) }}</span><span>{{ pointHeight[1].toFixed(3) }}</span>
            </div>
            <div v-if="inspectionMode" class="point-inspection">
              <div v-if="!inspectedPoints.length">{{ inspectionMode === 'distance' ? '在画布中点击起点 A' : '在画布中点击一个点' }}</div>
              <div v-for="(point, index) in inspectedPoints" :key="index" class="inspection-row">
                <code>{{ index ? 'B' : 'A' }} · {{ formatCoordinates(point.position) }}</code>
                <button type="button" @click="copyPoint(point)">复制坐标</button>
                <button type="button" @click="useRotationCenter(point)">设为旋转中心</button>
              </div>
              <div v-if="inspectionMode === 'distance' && inspectedPoints.length === 1">在画布中点击终点 B</div>
              <div v-if="measurement" class="measurement-result">
                <strong>距离 {{ measurement.distance.toFixed(3) }} {{ path ? 'mm' : '模型单位' }}</strong>
                <code>{{ formatCoordinates(measurement.delta, 'Δ') }}</code>
              </div>
              <div v-if="inspectedPoints.length" class="inspection-row">
                <button type="button" @click="setInspectedPoints([])">清除</button>
                <span role="status">{{ copyStatus }}</span>
              </div>
            </div>
          </div>
          <ViewCube v-if="orientation && (path || model)" :orientation="orientation" @select="lookFrom" @reset="resetView" />
          <div v-if="busy" class="placeholder" role="status"><span class="spinner"></span><strong>正在加载文件</strong></div>
          <div v-else-if="!path && !model" class="placeholder">
            <div class="empty-icon"><svg viewBox="0 0 48 48"><path d="M24 6 40 15v18l-16 9-16-9V15l16-9Zm0 18 16-9M24 24 8 15m16 9v18"/></svg></div>
            <h1>打开一个文件开始预览</h1>
            <p>将文件拖到这里，或从磁盘选择</p>
            <button class="open-button" @click="choose">选择本地文件</button>
            <small>G-CODE · NC · GLB · OBJ · PLY · PCD</small>
          </div>
          <div v-else-if="path && !path.kinds.length" class="placeholder"><strong>{{ path.issue ? '解析中断，请查看上方提示' : '没有可显示的运动轨迹' }}</strong></div>
          <div v-if="path && path.kinds.length" class="legend">
            <span><i class="rapid"></i>快移</span><span><i class="travel"></i>关光移动</span><span><i class="work" :class="{ gray: grayscale }"></i>{{ path.pointMode ? '内雕点' : '加工' }}</span>
          </div>
          <div v-if="position" class="coordinates" :aria-label="path?.crystal ? '水晶预览坐标' : '程序坐标'" :title="path?.crystal ? 'Z 显示折射率校正后的水晶层高' : undefined">
            <span v-for="(axis, index) in ['X', 'Y', 'Z']" :key="axis"><b>{{ axis }}</b> {{ position[index].toFixed(3) }}</span><small>mm</small>
          </div>
        </div>
        <footer v-if="path" class="playback">
          <button class="play-button" :disabled="!total || !!path.issue || overview" @click="togglePlayback">{{ playing ? '暂停' : total && distance >= total ? '重播' : '播放' }}</button>
          <input aria-label="播放进度" type="range" min="0" :max="sliderSteps" step="1" :value="sliderValue" :disabled="!total || !!path.issue || overview" @input="seek(Number(($event.target as HTMLInputElement).value) / sliderSteps * total)" />
          <output>{{ total ? Math.round(distance / total * 100) : 0 }}%</output>
          <select v-model.number="speed" aria-label="播放速度"><option v-for="value in speeds" :key="value" :value="value">{{ value }}×</option></select>
          <label><input v-model="hideTravel" type="checkbox" @change="viewport?.setHideTravel(hideTravel)" /> 隐藏移动路径</label>
        </footer>
        <footer v-if="model" class="model-footer">
          <span v-if="model.meshes">{{ model.meshes.toLocaleString() }} 个网格</span>
          <span v-if="model.points">{{ model.points.toLocaleString() }} 个点</span>
          <label v-if="model.points">点大小 <input v-model.number="pointSize" aria-label="点大小" type="range" min="1" max="12" step="1" @input="updatePointSize" /> {{ pointSize }} px</label>
        </footer>
      </section>
    </main>
    <div v-if="dragging > 0" class="drop-overlay">释放以打开文件</div>
  </div>
</template>
