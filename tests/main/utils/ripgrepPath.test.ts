// 主进程测试（node 环境）
import {describe, it, expect, afterAll} from 'vitest'
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'fs'
import {tmpdir} from 'os'
import {join} from 'path'
import {resolveRipgrepPath} from '../../../src/main/utils/ripgrepPath'

const roots: string[] = []

function makeRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hclaw-rgpath-'))
  roots.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of roots) rmSync(dir, {recursive: true, force: true})
})

describe('resolveRipgrepPath', () => {
  it('不含 app.asar 的路径原样返回（开发态）', () => {
    const p = 'E:\\repo\\node_modules\\@vscode\\ripgrep-win32-x64\\bin\\rg.exe'
    expect(resolveRipgrepPath(p)).toBe(p)
  })

  it('asar 路径且 unpacked 副本存在时改写为真实磁盘路径', () => {
    const root = makeRoot()
    const asarRel = 'node_modules\\@vscode\\ripgrep-win32-x64\\bin\\rg.exe'
    const unpacked = join(root, 'app.asar.unpacked', asarRel)
    mkdirSync(join(root, 'app.asar.unpacked', 'node_modules\\@vscode\\ripgrep-win32-x64\\bin'), {recursive: true})
    writeFileSync(unpacked, '')

    // app.asar 侧文件不需要真实存在：Electron 的 fs 透明化会让它「看起来存在」
    const fromAsar = join(root, 'app.asar', asarRel)
    expect(resolveRipgrepPath(fromAsar)).toBe(unpacked)
  })

  it('asar 路径但 unpacked 副本缺失时原样返回（不掩盖 spawn 失败）', () => {
    const root = makeRoot()
    const fromAsar = join(root, 'app.asar', 'node_modules', '@vscode', 'ripgrep-win32-x64', 'bin', 'rg.exe')
    expect(resolveRipgrepPath(fromAsar)).toBe(fromAsar)
  })

  it('已经在 app.asar.unpacked 下的路径不再二次改写', () => {
    const root = makeRoot()
    const p = join(root, 'app.asar.unpacked', 'node_modules', '@vscode', 'ripgrep-win32-x64', 'bin', 'rg.exe')
    expect(resolveRipgrepPath(p)).toBe(p)
  })

  it('POSIX 分隔符同样改写', () => {
    const root = makeRoot()
    const unpackedDir = join(root, 'app.asar.unpacked', 'node_modules', '@vscode', 'ripgrep-linux-x64', 'bin')
    mkdirSync(unpackedDir, {recursive: true})
    writeFileSync(join(unpackedDir, 'rg'), '')
    const fromAsar = join(root, 'app.asar', 'node_modules', '@vscode', 'ripgrep-linux-x64', 'bin', 'rg')
    expect(resolveRipgrepPath(fromAsar)).toBe(join(unpackedDir, 'rg'))
  })
})
