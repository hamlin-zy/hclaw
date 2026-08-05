/**
 * 注意提醒状态机 — 权限确认/ask_user 弹窗出现时提醒用户
 *
 * 跨平台策略：
 *   Windows → 隐藏到托盘：托盘图标 500ms 交替闪烁
 *           → 最小化：     win.flashFrame(true) 任务栏闪烁
 *           → 可见：       不提醒
 *   macOS   → dock.bounce('critical') 单次
 *   Linux   → flashFrame(true) + Notification 单次通知兜底
 *
 * 引用计数：`notifyUserAttention()` 仅在 count 0→1 时启动提醒，
 * `stopUserAttention()` 递减计数（归零才停止，响应用户 / worker 退出路径），
 * `clearUserAttention()` 无条件清零（窗口显示时调用）。
 */

import {app, nativeImage, Notification} from 'electron'
import {getMainWindow} from './window'
import {getTray, getTrayIconLoaded} from './tray'
import {getAppIconPath} from './utils/icon'

// ── 内部状态 ──

/** 引用计数：>0 表示存在至少一个未响应的弹窗 */
let attentionCount = 0

/** 托盘闪烁定时器句柄 */
let blinkTimer: ReturnType<typeof setInterval> | null = null

/** 缓存原始托盘图标和红色角标高亮图标 */
let originalTrayImage: Electron.NativeImage | null = null
let highlightImage: Electron.NativeImage | null = null

/** Linux 通知是否已发送（单次） */
let notificationSent = false

// ── 高亮图标生成（Windows 托盘闪烁用） ──

function buildHighlightIcon(): Electron.NativeImage | null {
  try {
    const icon = nativeImage.createFromPath(getAppIconPath())
    if (icon.isEmpty()) return null

    const size = icon.getSize()
    const bitmap = Buffer.from(icon.toBitmap())

    // 右下角红色圆点角标，BGRA 像素格式
    const badgeRadius = Math.floor(Math.min(size.width, size.height) * 0.12)
    const cx = size.width - badgeRadius - 4
    const cy = size.height - badgeRadius - 4

    const r2 = badgeRadius * badgeRadius
    for (let y = Math.max(0, cy - badgeRadius); y < Math.min(size.height, cy + badgeRadius + 1); y++) {
      for (let x = Math.max(0, cx - badgeRadius); x < Math.min(size.width, cx + badgeRadius + 1); x++) {
        if ((x - cx) ** 2 + (y - cy) ** 2 <= r2) {
          const offset = (y * size.width + x) * 4
          const alpha = 0.9
          bitmap[offset]     = Math.round(bitmap[offset]     * (1 - alpha) + 50  * alpha) // B
          bitmap[offset + 1] = Math.round(bitmap[offset + 1] * (1 - alpha) + 50  * alpha) // G
          bitmap[offset + 2] = Math.round(bitmap[offset + 2] * (1 - alpha) + 220 * alpha) // R
          bitmap[offset + 3] = 255                                                         // A
        }
      }
    }

    return nativeImage.createFromBitmap(bitmap, size)
  } catch {
    return null
  }
}

// ── 平台分派 ──

let _flashFrameCalled = false

function startBlinking(): void {
  const win = getMainWindow()
  if (!win || win.isDestroyed()) return

  const platform = process.platform

  // ── macOS ──
  if (platform === 'darwin') {
    try { app.dock.bounce('critical') } catch { /* ignore */ }
    return
  }

  // ── Linux ──
  if (platform === 'linux') {
    try { win.flashFrame(true); _flashFrameCalled = true } catch { /* ignore */ }
    if (!notificationSent) {
      notificationSent = true
      try {
        new Notification({title: 'HClaw', body: 'Agent 需要您的输入，请查看窗口'}).show()
      } catch { /* ignore */ }
    }
    return
  }

  // ── Windows ──
  try {
    if (win.isVisible()) return // 可见不提醒

    if (win.isMinimized()) {
      win.flashFrame(true)
      _flashFrameCalled = true
      return
    }

    // 隐藏到托盘 → 托盘图标闪烁
    const tray = getTray()
    if (!tray || tray.isDestroyed() || !getTrayIconLoaded()) {
      win.flashFrame(true); _flashFrameCalled = true; return
    }

    highlightImage = buildHighlightIcon()
    if (!highlightImage) {
      win.flashFrame(true); _flashFrameCalled = true; return
    }

    try { originalTrayImage = nativeImage.createFromPath(getAppIconPath()) } catch {
      win.flashFrame(true); _flashFrameCalled = true; return
    }

    let useHighlight = true
    blinkTimer = setInterval(() => {
      try {
        if (tray.isDestroyed()) { clearInterval(blinkTimer!); blinkTimer = null; return }
        tray.setImage(useHighlight ? highlightImage! : originalTrayImage!)
        useHighlight = !useHighlight
      } catch { clearInterval(blinkTimer!); blinkTimer = null }
    }, 500)
  } catch {
    try { win.flashFrame(true); _flashFrameCalled = true } catch { /* ignore */ }
  }
}

function stopBlinking(): void {
  if (blinkTimer) { clearInterval(blinkTimer); blinkTimer = null }

  if (originalTrayImage) {
    try {
      const tray = getTray()
      if (tray && !tray.isDestroyed()) tray.setImage(originalTrayImage)
    } catch { /* ignore */ }
  }

  _flashFrameCalled = false
  try {
    const win = getMainWindow()
    if (win && !win.isDestroyed()) win.flashFrame(false)
  } catch { /* ignore */ }

  originalTrayImage = null
  highlightImage = null
  notificationSent = false
}

// ── 公开 API ──

export function notifyUserAttention(): void {
  if (attentionCount === 0) startBlinking()
  attentionCount++
}

/** 递减计数，归零才停止（响应用户 / worker 退出路径） */
export function stopUserAttention(): void {
  if (attentionCount > 0) attentionCount--
  if (attentionCount === 0) stopBlinking()
}

/** 无条件清零（窗口 show 时调用，幂等） */
export function clearUserAttention(): void {
  attentionCount = 0
  stopBlinking()
}

export function hasActiveAttention(): boolean {
  return attentionCount > 0
}

// 内部导出供测试
export const _testInternals = {
  get _flashFrameCalled() { return _flashFrameCalled },
  get _blinkTimer() { return blinkTimer },
  reset() { stopBlinking(); attentionCount = 0; _flashFrameCalled = false },
}
