import { app, BrowserWindow, dialog, ipcMain, protocol } from 'electron'
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { open, readFile, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { Readable } from 'node:stream'
import {
  fileExtensions,
  fileExtension,
  isFileSizeAllowed,
} from '../shared/files'

protocol.registerSchemesAsPrivileged([
  { scheme: 'viewer-file', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
])

const reloadFiles = new Map<number, { token: string; path: string; size: number; modified: number }>()

ipcMain.handle('viewer:reload', async (event, path: string) => {
  if (event.senderFrame !== event.sender.mainFrame || !BrowserWindow.fromWebContents(event.sender)) return null
  const extension = fileExtension(path)
  if (!fileExtensions.includes(extension)) return null
  const info = await stat(path).catch(() => null)
  if (!info?.isFile()) throw new Error('无法读取原文件，请确认文件仍在原位置。')
  if (!isFileSizeAllowed(extension, info.size)) {
    throw new Error('原文件为空或超过预览大小上限。')
  }
  const id = event.sender.id
  if (!reloadFiles.has(id)) event.sender.once('destroyed', () => reloadFiles.delete(id))
  const token = randomUUID()
  reloadFiles.set(id, { token, path, size: info.size, modified: info.mtimeMs })
  return { url: `viewer-file://${token}/`, size: info.size, name: basename(path) }
})

async function readReloadFile(request: Request) {
  const url = new URL(request.url)
  const headers = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }
  const file = [...reloadFiles.values()].find(entry => entry.token === url.hostname)
  if (!file || request.method !== 'GET') return new Response(null, { status: 404, headers })
  const start = Number(url.searchParams.get('start') ?? 0)
  const end = Number(url.searchParams.get('end') ?? file.size)
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= end || end > file.size) {
    return new Response(null, { status: 416, headers })
  }
  const handle = await open(file.path, 'r').catch(() => null)
  if (!handle) return new Response(null, { status: 404, headers })
  const info = await handle.stat().catch(() => null)
  if (!info || info.size !== file.size || info.mtimeMs !== file.modified) {
    await handle.close()
    return new Response(null, { status: 409, headers })
  }
  return new Response(Readable.toWeb(handle.createReadStream({ start, end: end - 1 })) as ReadableStream, { headers })
}

const devRendererUrl = !app.isPackaged && process.env.ELECTRON_RENDERER_URL
if (devRendererUrl) {
  const devProfile = app.getPath('userData') + '-dev'
  mkdirSync(devProfile, { recursive: true })
  app.setPath('userData', devProfile)
}

ipcMain.handle('viewer:open', async (event) => {
  const window = BrowserWindow.fromWebContents(event.sender)
  if (!window || event.senderFrame !== event.sender.mainFrame) return null

  const { canceled, filePaths } = await dialog.showOpenDialog(window, {
    properties: ['openFile'],
    filters: [{ name: 'G-code / 三维文件', extensions: fileExtensions }],
  })
  if (canceled) return null

  const path = filePaths[0]
  const extension = fileExtension(path)
  if (!fileExtensions.includes(extension)) throw new Error('不支持此文件格式。')
  const info = await stat(path)
  if (!info.isFile() || !isFileSizeAllowed(extension, info.size)) {
    throw new Error('请选择受支持的非空文件。G-code 上限为 1 GiB，三维模型上限为 512 MiB。')
  }
  const bytes = await readFile(path)
  return { name: basename(path), bytes: Uint8Array.from(bytes).buffer }
})

function createWindow() {
  const window = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 860,
    minHeight: 600,
    backgroundColor: '#101820',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  if (devRendererUrl) {
    void window.loadURL(devRendererUrl)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

void app.whenReady().then(() => {
  protocol.handle('viewer-file', readReloadFile)
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
