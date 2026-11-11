import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

type PackageConfig = {
  scripts: Record<string, string>
  build: {
    win: { target: string }
    mac?: {
      target: string[]
      artifactName: string
    }
  }
}

const packageConfig = JSON.parse(
  readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'),
) as PackageConfig

describe('desktop packaging configuration', () => {
  it('keeps the Windows x64 ZIP build as the default dist command', () => {
    expect(packageConfig.scripts.dist).toBe('npm run dist:win')
    expect(packageConfig.scripts['dist:win']).toBe(
      'npm run build && electron-builder --win --x64',
    )
    expect(packageConfig.build.win.target).toBe('zip')
  })

  it('builds architecture-specific macOS DMG and ZIP artifacts', () => {
    expect(packageConfig.scripts['dist:mac']).toBe(
      'npm run build && electron-builder --mac --x64 --arm64',
    )
    expect(packageConfig.build.mac).toEqual({
      target: ['dmg', 'zip'],
      artifactName: '${productName}-${version}-mac-${arch}.${ext}',
    })
  })
})
