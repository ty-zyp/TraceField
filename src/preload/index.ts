import { contextBridge, ipcRenderer, webUtils } from 'electron'

contextBridge.exposeInMainWorld('viewer', {
  openFile: () => ipcRenderer.invoke('viewer:open'),
  reloadFile: (file: File) => {
    const path = webUtils.getPathForFile(file)
    return path ? ipcRenderer.invoke('viewer:reload', path) : null
  },
})
