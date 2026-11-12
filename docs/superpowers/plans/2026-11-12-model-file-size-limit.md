# 三维模型文件上限调整实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将所有三维模型文件入口的大小上限从 128 MiB 统一提高到 512 MiB，同时保持 G-code 的 1 GiB 上限。

**Architecture:** 共享文件模块继续持有两类文件的上限，并新增统一的按扩展名取上限及校验函数。渲染进程和主进程都调用这些函数，避免选择、拖放、参考模型和重载路径出现不同规则。

**Tech Stack:** TypeScript、Vue 3、Electron、Vitest

## Global Constraints

- GLB、OBJ、PLY、PCD 主模型上限为 512 MiB。
- PLY、PCD、GLB 参考模型上限为 512 MiB。
- G-code 上限保持 1 GiB。
- 不改变支持格式、模型解析方式或渲染复杂度保护策略。
- 空文件和超过对应上限的文件必须在读取前拒绝。

---

### Task 1: 集中定义并测试文件大小规则

**Files:**
- Create: `tests/files.test.ts`
- Modify: `src/shared/files.ts:1-5`

**Interfaces:**
- Produces: `maxFileBytes: number`，值为 512 MiB。
- Produces: `fileSizeLimit(extension: string): number`，G-code 扩展名返回 1 GiB，其他扩展名返回 512 MiB。
- Produces: `isFileSizeAllowed(extension: string, size: number): boolean`，仅接受大于 0 且不超过对应上限的大小。

- [ ] **Step 1: 编写失败测试**

创建 `tests/files.test.ts`：

```ts
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
    expect(fileSizeLimit('glb')).toBe(maxFileBytes)
    expect(fileSizeLimit('pcd')).toBe(maxFileBytes)
    expect(fileSizeLimit('gcode')).toBe(maxGcodeBytes)
    expect(fileSizeLimit('nc')).toBe(maxGcodeBytes)
  })

  it('accepts the exact limit and rejects empty or oversized files', () => {
    expect(isFileSizeAllowed('glb', maxFileBytes)).toBe(true)
    expect(isFileSizeAllowed('glb', maxFileBytes + 1)).toBe(false)
    expect(isFileSizeAllowed('glb', 0)).toBe(false)
    expect(isFileSizeAllowed('gcode', maxGcodeBytes)).toBe(true)
    expect(isFileSizeAllowed('gcode', maxGcodeBytes + 1)).toBe(false)
  })
})
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `pnpm vitest run tests/files.test.ts`

Expected: FAIL，因为 `fileSizeLimit`、`isFileSizeAllowed` 尚未导出，且 `maxFileBytes` 仍为 128 MiB。

- [ ] **Step 3: 实现共享规则**

将 `src/shared/files.ts` 顶部改为：

```ts
export const gcodeExtensions = ['gcode', 'nc', 'tap', 'ngc']
export const fileExtensions = [...gcodeExtensions, 'glb', 'obj', 'ply', 'pcd']
export const maxFileBytes = 512 * 1024 * 1024
export const maxGcodeBytes = 1024 * 1024 * 1024
export const fileExtension = (name: string) => name.split('.').pop()?.toLowerCase() ?? ''
export const fileSizeLimit = (extension: string) =>
  gcodeExtensions.includes(extension) ? maxGcodeBytes : maxFileBytes
export const isFileSizeAllowed = (extension: string, size: number) =>
  size > 0 && size <= fileSizeLimit(extension)
```

- [ ] **Step 4: 运行定向测试并确认通过**

Run: `pnpm vitest run tests/files.test.ts`

Expected: PASS，2 tests passed。

- [ ] **Step 5: 提交共享规则**

```bash
git add src/shared/files.ts tests/files.test.ts
git commit -m "feat: raise model file limit to 512 MiB"
```

---

### Task 2: 统一所有入口并更新用户文档

**Files:**
- Modify: `src/renderer/src/App.vue:4,385-390,570-576`
- Modify: `src/main/index.ts:7,15-23,58-74`
- Modify: `README.md:9,62`

**Interfaces:**
- Consumes: `isFileSizeAllowed(extension: string, size: number): boolean` from Task 1。
- Consumes: `fileExtension(name: string): string`、`fileExtensions` from `src/shared/files.ts`。

- [ ] **Step 1: 让渲染进程统一调用共享校验**

在 `src/renderer/src/App.vue` 中导入 `isFileSizeAllowed`，移除不再直接使用的 `maxFileBytes` 和 `maxGcodeBytes`：

```ts
import {
  fileExtension,
  fileExtensions,
  gcodeExtensions,
  isFileSizeAllowed,
  readFileBytes,
  type DiskFile,
} from '../../shared/files'
```

主文件校验改为：

```ts
if (!fileExtensions.includes(extension) || !isFileSizeAllowed(extension, file.size)) {
  error.value = '请选择受支持的非空文件。G-code 上限为 1 GiB，三维模型上限为 512 MiB。'
  return
}
```

参考模型校验改为：

```ts
if (!referenceExtensions.includes(extension) || !isFileSizeAllowed(extension, file.size)) {
  referenceError.value = '请选择 512 MiB 以内的 PLY、PCD 或 GLB 文件。'
  return
}
```

- [ ] **Step 2: 让主进程的重载和文件对话框统一调用共享校验**

在 `src/main/index.ts` 中将共享导入改为：

```ts
import {
  fileExtensions,
  fileExtension,
  isFileSizeAllowed,
} from '../shared/files'
```

`viewer:reload` 中使用共享扩展名解析和校验：

```ts
const extension = fileExtension(path)
if (!fileExtensions.includes(extension)) return null
const info = await stat(path).catch(() => null)
if (!info?.isFile()) throw new Error('无法读取原文件，请确认文件仍在原位置。')
if (!isFileSizeAllowed(extension, info.size)) {
  throw new Error('原文件为空或超过预览大小上限。')
}
```

`viewer:open` 中使用相同规则：

```ts
const extension = fileExtension(path)
if (!fileExtensions.includes(extension)) throw new Error('不支持此文件格式。')
const info = await stat(path)
if (!info.isFile() || !isFileSizeAllowed(extension, info.size)) {
  throw new Error('请选择受支持的非空文件。G-code 上限为 1 GiB，三维模型上限为 512 MiB。')
}
```

- [ ] **Step 3: 更新 README 限制说明**

将 README 两处保护阈值从 128 MiB 改为 512 MiB：

```md
GLB 使用内嵌资源，OBJ 使用文件中的几何与点。首版对单个三维模型设置 512 MiB 的读取保护上限，对 G-code 设置 200 万渲染线段的保护上限。加载表现取决于几何复杂度和电脑配置。
```

```md
以上是该次样本实测，512 MiB 和 200 万段是保护阈值。
```

- [ ] **Step 4: 检查遗留文案**

Run: `rg "128 MiB|三维模型上限" src README.md`

Expected: 仅找到包含 `三维模型上限为 512 MiB` 的新文案，不再出现 `128 MiB`。

- [ ] **Step 5: 运行完整验证**

Run: `pnpm test && pnpm check`

Expected: Vitest 全部通过，`vue-tsc --noEmit` 退出码为 0。

- [ ] **Step 6: 提交入口和文档改动**

```bash
git add src/renderer/src/App.vue src/main/index.ts README.md
git commit -m "fix: apply 512 MiB model limit consistently"
```
