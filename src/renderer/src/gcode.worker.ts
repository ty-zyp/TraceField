import { loadGcodeFile, type GcodeLineRange, type GcodeSourceIndex } from '../../shared/gcodeFile'
import type { DiskFile } from '../../shared/files'

self.onmessage = async ({ data }: MessageEvent<{ file: File | DiskFile; index?: GcodeSourceIndex; range?: GcodeLineRange }>) => {
  try {
    const result = await loadGcodeFile(data.file, data.index, data.range,
      data.range ? progress => self.postMessage({ progress }) : undefined)
    const { path } = result
    const transfer = [path.positions, path.kinds, path.powers, path.lines, path.distances]
      .map(array => array.buffer as ArrayBuffer)
    self.postMessage(result, { transfer })
  } catch (error) {
    self.postMessage({ error: (error as Error).message })
  }
}
