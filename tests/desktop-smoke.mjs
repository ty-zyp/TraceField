import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const fixtures = process.env.LDS_FIXTURE_ROOT
assert(fixtures, 'Set LDS_FIXTURE_ROOT to the LDS docs/fixtures directory.')
const dir = await mkdtemp(join(tmpdir(), 'lds-viewer-smoke-'))
const port = await new Promise((resolve, reject) => {
  const server = createServer().once('error', reject).listen(0, '127.0.0.1', () => {
    const { port } = server.address()
    server.close(() => resolve(port))
  })
})

function glbFixture() {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64')
  const bin = Buffer.alloc(Math.ceil((60 + png.length) / 4) * 4)
  new Float32Array(bin.buffer, bin.byteOffset, 15).set([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1])
  png.copy(bin, 60)
  const json = Buffer.from(JSON.stringify({
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    buffers: [{ byteLength: bin.length }],
    bufferViews: [{ buffer: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 24 }, { buffer: 0, byteOffset: 60, byteLength: png.length }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5126, count: 3, type: 'VEC2' },
    ],
    images: [{ bufferView: 2, mimeType: 'image/png' }], textures: [{ source: 0 }],
    materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
    meshes: [{ primitives: [
      { attributes: { POSITION: 0, TEXCOORD_0: 1 }, material: 0 },
      { attributes: { POSITION: 0 }, mode: 0 },
    ] }],
  }))
  const padded = Buffer.concat([json, Buffer.alloc((4 - json.length % 4) % 4, 32)])
  const header = Buffer.alloc(20)
  header.write('glTF')
  header.writeUInt32LE(2, 4)
  header.writeUInt32LE(28 + padded.length + bin.length, 8)
  header.writeUInt32LE(padded.length, 12)
  header.write('JSON', 16)
  const chunk = Buffer.alloc(8)
  chunk.writeUInt32LE(bin.length)
  chunk.write('BIN\0', 4)
  return Buffer.concat([header, padded, chunk, bin])
}

function cloudFixture() {
  const count = 1_000_000
  const header = Buffer.from('VERSION 0.7\nFIELDS x y z\nSIZE 4 4 4\nTYPE F F F\nCOUNT 1 1 1\nWIDTH 1000000\nHEIGHT 1\nPOINTS 1000000\nDATA binary\n')
  const bytes = Buffer.alloc(count * 12)
  const positions = new Float32Array(bytes.buffer, bytes.byteOffset, count * 3)
  for (let i = 0; i < count; i++) {
    positions[i * 3] = i % 1000 / 10
    positions[i * 3 + 1] = Math.floor(i / 1000) / 10
    positions[i * 3 + 2] = Math.sin(i % 1000 / 80) * Math.cos(Math.floor(i / 1000) / 100) * 6
  }
  return Buffer.concat([header, bytes])
}

const files = {
  'mixed.glb': glbFixture(),
  'mixed.obj': 'o mesh\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\no cloud\np 1 2 3\n',
  'mesh.ply': 'ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\nelement face 1\nproperty list uchar int vertex_indices\nend_header\n0 0 0\n1 0 0\n0 1 0\n3 0 1 2\n',
  'points.ply': 'ply\nformat ascii 1.0\nelement vertex 2\nproperty float x\nproperty float y\nproperty float z\nend_header\n0 0 0\n1 0 0\n',
  'million.pcd': cloudFixture(),
  'frequency.gcode': 'G90\nG21\nM4 S800\nG0 F3000 Q40 S800\nG0X24.03Y12.9\nG1X40.8Y12.9F3000S800Q40\nG1X40.8Y26.97\nG1X24.03Y26.97\nG1X24.03Y12.9\nM5\nM2',
}
await Promise.all(Object.entries(files).map(([name, data]) => writeFile(join(dir, name), data)))

const exe = resolve(process.argv[2] ?? 'release/win-unpacked/TraceField.exe')
const appArgs = process.argv[3] ? [resolve(process.argv[3])] : []
const child = spawn(exe, [...appArgs, `--remote-debugging-port=${port}`, `--user-data-dir=${join(dir, 'profile')}`], { windowsHide: true, stdio: 'ignore' })
let socket
let launchError
child.once('error', error => { launchError = error })

async function until(check, label, timeout = 35_000) {
  const end = performance.now() + timeout
  while (performance.now() < end) {
    if (launchError) throw launchError
    if (child.exitCode !== null) throw new Error(`Electron exited: ${child.exitCode}`)
    const result = await check()
    if (result) return result
    await sleep(35)
  }
  throw new Error(`Timeout: ${label}`)
}

try {
  const targets = await until(async () => {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      return list.find(target => target.type === 'page' && target.url.includes('index.html'))
    } catch {
      return null
    }
  }, 'Electron DevTools')
  socket = new WebSocket(targets.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  let nextId = 0
  const pending = new Map()
  const errors = []
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data)
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text)
    if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') errors.push(message.params.entry.text)
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      errors.push(message.params.args.map(arg => arg.value ?? arg.description).join(' '))
    }
    const callback = pending.get(message.id)
    if (callback) {
      pending.delete(message.id)
      callback(message)
    }
  })

  function cdp(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++nextId
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`CDP timed out: ${method}`))
      }, 40_000)
      pending.set(id, message => {
        clearTimeout(timer)
        if (message.error) reject(new Error(message.error.message))
        else resolve(message.result)
      })
      socket.send(JSON.stringify({ id, method, params }))
    })
  }

  async function evaluate(expression) {
    const response = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text)
    return response.result.value
  }

  await cdp('Runtime.enable')
  await cdp('Log.enable')
  await until(() => evaluate('document.querySelector("canvas")?.width'), 'WebGL viewport')
  assert.equal(await evaluate('typeof window.viewer.openFile'), 'function')

  async function openFile(path, selector) {
    const { root } = await cdp('DOM.getDocument')
    const { nodeId } = await cdp('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file]' })
    const started = performance.now()
    await cdp('DOM.setFileInputFiles', { nodeId, files: [path] })
    await until(async () => {
      const state = await evaluate(`({ match: !!document.querySelector(${JSON.stringify(selector)}), error: document.querySelector('[role=alert]')?.textContent?.trim() })`)
      if (state.error && selector !== '[role=alert]') throw new Error(state.error)
      return state.match
    }, path)
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))')
    return Math.round(performance.now() - started)
  }

  await openFile(join(dir, 'frequency.gcode'), '.playback input[type=range]:enabled')
  await evaluate(`(() => { const range = document.querySelector('.playback input[type=range]'); range.value = range.max; range.dispatchEvent(new Event('input')); })()`)
  assert.match(await evaluate('document.querySelector(".coordinates").textContent'), /24\.030.*12\.900/)
  await writeFile(join(dir, 'frequency.gcode'), 'G90\nG1X77Y88\nM2')
  await evaluate('document.querySelector(".reload-button").click()')
  await until(() => evaluate('document.querySelector(".source-window")?.textContent.includes("G1X77Y88")'), 'reload overwritten file')
  await evaluate(`(() => { const range = document.querySelector('.playback input[type=range]'); range.value = range.max; range.dispatchEvent(new Event('input')); })()`)
  assert.match(await evaluate('document.querySelector(".coordinates").textContent'), /77\.000.*88\.000/)

  const line = join(fixtures, 'md2-handoff/_repeat-compare/v-mt-01-line-repeat-1.gcode')
  await openFile(line, '.playback input[type=range]:enabled')
  await evaluate('document.querySelectorAll(".view-tools button")[1].click()')
  assert.equal(await evaluate('document.querySelectorAll(".view-tools button")[1].getAttribute("aria-pressed")'), 'true')
  await evaluate('document.querySelector(".play-button").click()')
  await until(() => evaluate('parseFloat(document.querySelector(".playback input[type=range]").value) > 0'), 'playback advance')
  await evaluate('document.querySelector(".play-button").click()')
  const paused = await evaluate('document.querySelector(".playback input[type=range]").value')
  await sleep(150)
  assert.equal(await evaluate('document.querySelector(".playback input[type=range]").value'), paused)
  await evaluate(`(() => { const range = document.querySelector('.playback input[type=range]'); range.value = '0'; range.dispatchEvent(new Event('input')); })()`)
  assert.match(await evaluate('document.querySelector(".coordinates").textContent'), /X\s*0\.000/)
  await evaluate(`(() => { const range = document.querySelector('.playback input[type=range]'); range.value = range.max; range.dispatchEvent(new Event('input')); })()`)
  assert.equal(await evaluate('document.querySelector(".play-button").textContent.trim()'), '重播')
  assert.match(await evaluate('document.querySelector(".coordinates").textContent'), /133\.900/)
  await until(() => evaluate('document.querySelector(".source-row.active code")?.textContent.includes("G0X133.9")'), 'source line after seeking')
  await evaluate(`(() => {
    const files = new DataTransfer();
    files.items.add(new File(['G0X1\\n' + '; filler\\n'.repeat(2100) + 'G92X0\\nG1X4'], 'partial.gcode'));
    document.querySelector('.canvas').dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: files }));
  })()`)
  await until(() => evaluate('document.querySelector(".parse-report summary")?.textContent.includes("跳过 1 行")'), 'warning for skipped instruction')
  await evaluate('document.querySelector(".parse-report summary").click(); document.querySelector(".parse-report-group button").click()')
  await until(() => evaluate('document.querySelector(".parse-report-source code")?.textContent === "G92X0"'), 'original source in report')
  assert.equal(await evaluate('document.querySelector(".source-row.active span")?.textContent'), '2102')
  assert.equal(await evaluate('document.querySelector(".play-button").disabled'), false)

  const raster = join(fixtures, 'md2-handoff/lx2-algo-handoff-2026-06-11-full/_selftest-output/cpp-fixture.gcode')
  const rasterMs = await openFile(raster, '.playback input[type=range]:enabled')
  await evaluate(`(() => { const range = document.querySelector('.playback input[type=range]'); range.value = range.max; range.dispatchEvent(new Event('input')); })()`)
  assert(await evaluate('Number(document.querySelector(".source-row.active span").textContent) > 1000000'))

  const largeFile = join(dir, 'large.gcode')
  await writeFile(largeFile, 'G91\n' + 'G1X1\n'.repeat(2_000_020))
  await openFile(largeFile, '.reference-panel input[type=number]')
  assert.equal(await evaluate('document.querySelector(".play-button").disabled'), true)
  await evaluate(`(() => {
    const [first, size] = document.querySelectorAll('.reference-panel input[type=number]');
    if (size.value !== '2000000') throw new Error('Wrong default detail size');
    first.value = '2000021';
    size.value = '1';
    for (const input of [first, size]) input.dispatchEvent(new Event('input'));
    document.querySelector('.reference-panel button').click();
  })()`)
  await until(() => evaluate('!document.querySelector(".play-button").disabled'), 'large-file detail')
  await evaluate(`(() => { const range = document.querySelector('.playback input[type=range]'); range.value = range.max; range.dispatchEvent(new Event('input')); })()`)
  assert.match(await evaluate('document.querySelector(".coordinates").textContent'), /2000020\.000/)
  await evaluate('Array.from(document.querySelectorAll(".reference-panel button")).find(button => button.textContent.includes("加载下一段")).click()')
  await until(() => evaluate('document.querySelector(".detail-progress progress")?.value > 0'), 'detail loading progress')
  await evaluate('document.querySelector(".detail-progress button").click()')
  await until(() => evaluate('!document.querySelector(".detail-progress")'), 'cancel detail loading')
  assert(await evaluate('document.querySelector(".reference-panel").textContent.includes("已加载第 2,000,021 至 2,000,021 行")'))
  assert.match(await evaluate('document.querySelector(".coordinates").textContent'), /2000020\.000/)
  await evaluate('Array.from(document.querySelectorAll(".reference-panel button")).find(button => button.textContent.includes("加载下一段")).click()')
  await until(() => evaluate('document.querySelector(".reference-panel").textContent.includes("已加载第 2,000,022 至 2,000,022 行")'), 'next detail with no motion')
  assert(await evaluate('Array.from(document.querySelectorAll(".reference-panel button")).find(button => button.textContent.includes("加载下一段")).disabled'))
  await evaluate('Array.from(document.querySelectorAll(".reference-panel button")).find(button => button.textContent.includes("加载上一段")).click()')
  await until(() => evaluate('document.querySelector(".reference-panel").textContent.includes("已加载第 2,000,021 至 2,000,021 行")'), 'previous detail')
  await evaluate('Array.from(document.querySelectorAll(".reference-panel button")).find(button => button.textContent.includes("返回概览")).click()')
  assert.equal(await evaluate('document.querySelector(".play-button").disabled'), true)

  for (const [name, expected] of [
    ['mixed.glb', /1 个网格.*3 个点/], ['mixed.obj', /1 个网格.*3 个点/],
    ['mesh.ply', /1 个网格/], ['points.ply', /2 个点/],
  ]) {
    await openFile(join(dir, name), '.model-footer')
    assert.match(await evaluate('document.querySelector(".model-footer").textContent'), expected)
  }
  const pointsMs = await openFile(join(dir, 'million.pcd'), '.model-footer')
  assert.match(await evaluate('document.querySelector(".model-footer").textContent'), /1,000,000 个点/)
  await evaluate(`(() => { const range = document.querySelector('[aria-label="点大小"]'); range.value = '5'; range.dispatchEvent(new Event('input')); })()`)
  assert.match(await evaluate('document.querySelector(".model-footer").textContent'), /5 px/)

  const beforeRotation = (await cdp('Page.captureScreenshot', { format: 'jpeg', quality: 35 })).data
  const [x, y] = await evaluate('(() => { const b = document.querySelector("canvas").getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height / 2]; })()')
  await evaluate(`(() => { window.rotationFrames = 0; window.measureRotation = true; const tick = () => { if (window.measureRotation) { window.rotationFrames++; requestAnimationFrame(tick); } }; requestAnimationFrame(tick); })()`)
  const rotating = performance.now()
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', buttons: 1, clickCount: 1, x, y })
  for (let i = 0; i < 48; i++) {
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', button: 'left', buttons: 1, x: x + Math.sin(i / 7) * 130, y: y + Math.cos(i / 7) * 90 })
    await sleep(17)
  }
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', buttons: 0, x, y })
  const frames = await evaluate('window.measureRotation = false; window.rotationFrames')
  const elapsed = performance.now() - rotating
  assert.notEqual((await cdp('Page.captureScreenshot', { format: 'jpeg', quality: 35 })).data, beforeRotation)
  const peakMiB = Number(execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Process -Name 'TraceField' | Measure-Object PeakWorkingSet64 -Sum).Sum / 1MB`], { encoding: 'utf8', windowsHide: true }).trim())
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ rasterMs, pointsMs, rotationFramesPerSecond: Math.round(frames * 1000 / elapsed), sumOfProcessPeakWorkingSetsMiB: Math.round(peakMiB) }))
} finally {
  socket?.close()
  child.kill()
  await sleep(250)
  await rm(dir, { recursive: true, force: true, maxRetries: 5 }).catch(() => {})
}
