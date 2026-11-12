export const gcodeExtensions = ['gcode', 'nc', 'tap', 'ngc']
export const fileExtensions = [...gcodeExtensions, 'glb', 'obj', 'ply', 'pcd']
export const maxFileBytes = 512 * 1024 * 1024
export const maxGcodeBytes = 1024 * 1024 * 1024
export const fileExtension = (name: string) => name.split('.').pop()?.toLowerCase() ?? ''
export const fileSizeLimit = (extension: string) =>
  gcodeExtensions.includes(extension) ? maxGcodeBytes : maxFileBytes
export const isFileSizeAllowed = (extension: string, size: number) =>
  size > 0 && size <= fileSizeLimit(extension)

export interface DiskFile {
  name: string
  size: number
  url: string
}

export async function readFileBytes(file: Blob | DiskFile, start = 0, end = file.size, signal?: AbortSignal) {
  if (start === end) return new ArrayBuffer(0)
  if (file instanceof Blob) return file.slice(start, end).arrayBuffer()
  const response = await fetch(`${file.url}?start=${start}&end=${end}`, { signal })
  if (!response.ok) throw new Error('无法读取原文件，文件可能已更改或移走。')
  return response.arrayBuffer()
}
