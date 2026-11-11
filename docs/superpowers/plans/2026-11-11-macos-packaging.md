# TraceField macOS Packaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a single command that produces separate arm64 and x64 macOS DMG and ZIP packages while preserving the existing Windows packaging command.

**Architecture:** Keep all platform packaging metadata in `package.json`. Add a small Vitest contract test for scripts, targets, and artifact naming, then document local builds and optional certificate-based signing in README.

**Tech Stack:** Electron 42, electron-builder 26, pnpm 11, Vitest 3, TypeScript 5.9

## Global Constraints

- `pnpm dist` must continue to build the Windows x64 ZIP package.
- `pnpm dist:mac` must produce separate arm64 and x64 packages.
- macOS output formats are DMG and ZIP.
- macOS artifact names must include `mac` and `${arch}`.
- Signing credentials must only come from environment variables.
- Apple notarization is outside this implementation.
- Use the Electron default icon until a project `.icns` file is supplied.

---

### Task 1: Add Tested macOS Packaging Configuration

**Files:**
- Create: `tests/packageConfig.test.ts`
- Modify: `package.json:6-47`

**Interfaces:**
- Consumes: the existing `package.json` scripts and electron-builder configuration.
- Produces: `pnpm dist:win`, `pnpm dist:mac`, and a backward-compatible `pnpm dist`.

- [ ] **Step 1: Write the failing configuration contract test**

Create `tests/packageConfig.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the contract test and verify it fails**

Run:

```bash
pnpm vitest run tests/packageConfig.test.ts
```

Expected: one or both tests fail because `dist:win`, `dist:mac`, and `build.mac` do not exist.

- [ ] **Step 3: Add the macOS and compatibility scripts**

Change the relevant `package.json` scripts to:

```json
"build": "npm run check && electron-vite build",
"dist": "npm run dist:win",
"dist:win": "npm run build && electron-builder --win --x64",
"dist:mac": "npm run build && electron-builder --mac --x64 --arm64"
```

Add this next to the existing `build.win` configuration:

```json
"mac": {
  "target": [
    "dmg",
    "zip"
  ],
  "artifactName": "${productName}-${version}-mac-${arch}.${ext}"
}
```

- [ ] **Step 4: Run focused and full automated checks**

Run:

```bash
pnpm vitest run tests/packageConfig.test.ts
pnpm check
pnpm test
```

Expected: all commands exit with code 0; the focused test reports 2 passing tests.

- [ ] **Step 5: Commit packaging configuration**

```bash
git add package.json tests/packageConfig.test.ts
git commit -m "build: add macOS packaging targets"
```

---

### Task 2: Document macOS Builds and Signing

**Files:**
- Modify: `README.md:13-43`

**Interfaces:**
- Consumes: the scripts and artifact naming introduced by Task 1.
- Produces: reproducible developer instructions without embedding credentials.

- [ ] **Step 1: Update build documentation**

Replace the release-command paragraph with instructions that include:

```bash
pnpm test
pnpm dist
pnpm dist:mac
```

Document these macOS artifacts for version `0.1.2`:

```text
release/TraceField-0.1.2-mac-arm64.dmg
release/TraceField-0.1.2-mac-arm64.zip
release/TraceField-0.1.2-mac-x64.dmg
release/TraceField-0.1.2-mac-x64.zip
```

Add optional signing instructions:

```bash
export CSC_LINK='/path/to/DeveloperIDApplication.p12'
export CSC_KEY_PASSWORD='certificate-password'
pnpm dist:mac
```

State explicitly that secrets must not be committed and that this configuration does not perform Apple notarization. Explain that unsigned or unnotarized packages can be blocked by Gatekeeper on other Macs.

- [ ] **Step 2: Verify documented commands and names match configuration**

Run:

```bash
pnpm vitest run tests/packageConfig.test.ts
rg 'dist:mac|mac-arm64|mac-x64|CSC_LINK|CSC_KEY_PASSWORD|公证|Gatekeeper' README.md
```

Expected: the test passes and every documented command, artifact architecture, signing variable, and distribution warning is found.

- [ ] **Step 3: Commit documentation**

```bash
git add README.md
git commit -m "docs: add macOS packaging instructions"
```

---

### Task 3: Verify Real macOS Artifacts

**Files:**
- Generated: `release/TraceField-0.1.2-mac-arm64.dmg`
- Generated: `release/TraceField-0.1.2-mac-arm64.zip`
- Generated: `release/TraceField-0.1.2-mac-x64.dmg`
- Generated: `release/TraceField-0.1.2-mac-x64.zip`

**Interfaces:**
- Consumes: `pnpm dist:mac` from Task 1.
- Produces: four architecture-specific distributable files under `release`.

- [ ] **Step 1: Build both macOS architectures**

Run:

```bash
pnpm dist:mac
```

Expected: electron-builder exits with code 0 after creating arm64 and x64 DMG and ZIP targets.

- [ ] **Step 2: Verify all expected artifacts exist**

Run:

```bash
for file in \
  release/TraceField-0.1.2-mac-arm64.dmg \
  release/TraceField-0.1.2-mac-arm64.zip \
  release/TraceField-0.1.2-mac-x64.dmg \
  release/TraceField-0.1.2-mac-x64.zip
do
  test -s "$file" || exit 1
done
```

Expected: exit code 0, proving that all four files exist and are non-empty.

- [ ] **Step 3: Confirm generated artifacts remain untracked**

Run:

```bash
git status --short
```

Expected: no files under `release/` are listed because the existing `.gitignore` excludes that directory.
