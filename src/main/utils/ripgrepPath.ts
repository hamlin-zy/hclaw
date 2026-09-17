/**
 * ripgrep 可执行文件路径解析（打包后 asar 路径 → 真实磁盘路径）。
 *
 * @vscode/ripgrep 的 rgPath 由 require.resolve 得出。打进 asar 后它长这样：
 *   <resources>/app.asar/node_modules/@vscode/ripgrep-<platform>-<arch>/bin/rg[.exe]
 *
 * 坑：**Electron 只对 fs 做 asar 路径透明化**——`fs.existsSync(asar 路径)` 返回 true，
 * 于是一路「文件明明存在」的假象；但 `child_process` 不做透明化，
 * Windows 上 CreateProcess 拿到这个虚拟路径直接报 ENOENT（POSIX 同理）。
 * 真实可执行的副本在同级的 `app.asar.unpacked/` 下（electron-builder 的 smartUnpack /
 * electron-builder.yml 的 asarUnpack 负责放出去），必须改写后再 spawn。
 *
 * 实测（Electron 43，dist/win-unpacked）：
 *   spawn(rgPath)            → ENOENT
 *   spawn(rgPath 改写后)      → 0 / ripgrep 15.0.0
 */
import {existsSync} from 'fs'
import {rgPath} from '@vscode/ripgrep'

const ASAR_SEGMENT = 'app.asar'
const UNPACKED_SEGMENT = 'app.asar.unpacked'

/**
 * 把 app.asar 内的路径改写为 app.asar.unpacked 下的真实路径。
 * - 不含 app.asar → 原样返回（开发态 / 已解包发行版）
 * - 已在 app.asar.unpacked 下 → 原样返回
 * - 改写目标不存在 → 原样返回（不隐藏问题，让 spawn 的失败照常上报）
 */
export function resolveRipgrepPath(raw: string = rgPath): string {
  const idx = raw.indexOf(ASAR_SEGMENT)
  if (idx === -1) return raw
  if (raw.startsWith(UNPACKED_SEGMENT, idx)) return raw
  const unpacked = `${raw.slice(0, idx)}${UNPACKED_SEGMENT}${raw.slice(idx + ASAR_SEGMENT.length)}`
  return existsSync(unpacked) ? unpacked : raw
}

/** 运行期实际用于 spawn 的 rg 可执行文件路径 */
export const rgBinPath = resolveRipgrepPath()
