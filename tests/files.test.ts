import { describe, expect, it } from 'vitest'
import {
  fileSizeLimit,
  isFileSizeAllowed,
  maxFileBytes,
  maxGcodeBytes,
} from '../src/shared/files'

describe('file size limits', () => {
  it('uses 512 MiB for 3D models and 1 GiB for G-code', () => {
    expect(maxFileBytes).toBe(512 * 1024 * 1024)
    expect(maxGcodeBytes).toBe(1024 * 1024 * 1024)
  })

  it.each(['glb', 'obj', 'ply', 'pcd'])('uses the model limit for .%s files', (extension) => {
    expect(fileSizeLimit(extension)).toBe(maxFileBytes)
  })

  it.each(['gcode', 'nc', 'tap', 'ngc'])('uses the G-code limit for .%s files', (extension) => {
    expect(fileSizeLimit(extension)).toBe(maxGcodeBytes)
  })

  it('accepts the exact limit and rejects empty or oversized files', () => {
    expect(isFileSizeAllowed('glb', maxFileBytes)).toBe(true)
    expect(isFileSizeAllowed('glb', maxFileBytes + 1)).toBe(false)
    expect(isFileSizeAllowed('glb', 0)).toBe(false)
    expect(isFileSizeAllowed('gcode', maxGcodeBytes)).toBe(true)
    expect(isFileSizeAllowed('gcode', maxGcodeBytes + 1)).toBe(false)
  })
})
