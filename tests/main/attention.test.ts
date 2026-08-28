// tests/main/attention.test.ts
import {describe, expect, it, vi, beforeEach, afterEach} from 'vitest'

// ── Mock electron ──
const mockFlashFrame = vi.fn()
const mockDockBounce = vi.fn()
const mockSetImage = vi.fn()
const mockNotificationShow = vi.fn()
const mockCreateFromPath = vi.fn()
const mockCreateFromBitmap = vi.fn()

vi.mock('electron', () => ({
  app: { dock: { bounce: mockDockBounce } },
  nativeImage: {
    createFromPath: (...args: any[]) => mockCreateFromPath(...args),
    createFromBitmap: (...args: any[]) => mockCreateFromBitmap(...args),
  },
  Notification: class {
    show() { mockNotificationShow() }
    constructor(_opts: any) {}
  } as any,
}))

// ── Mock window ──
const mockGetMainWindow = vi.fn()
vi.mock('../../src/main/window', () => ({ getMainWindow: () => mockGetMainWindow() }))

// ── Mock tray ──
const mockGetTray = vi.fn()
const mockGetTrayIconLoaded = vi.fn()
vi.mock('../../src/main/tray', () => ({
  getTray: () => mockGetTray(),
  getTrayIconLoaded: () => mockGetTrayIconLoaded(),
}))

// ── Mock icon utils ──
vi.mock('../../src/main/utils/icon', () => ({ getAppIconPath: () => '/fake/icon.png' }))

// ── Helpers ──
function setupWindow(opts: {visible: boolean; minimized: boolean; destroyed?: boolean}): ReturnType<typeof vi.fn> {
  const win = {
    isVisible: () => opts.visible,
    isMinimized: () => opts.minimized,
    isDestroyed: () => !!opts.destroyed,
    flashFrame: mockFlashFrame,
    once: vi.fn(),
  }
  mockGetMainWindow.mockReturnValue(win)
  return mockFlashFrame
}

function setupTray(opts: {exists: boolean; iconLoaded: boolean}): ReturnType<typeof vi.fn> {
  const tray = opts.exists ? {setImage: mockSetImage, isDestroyed: () => false} : null
  mockGetTray.mockReturnValue(tray)
  mockGetTrayIconLoaded.mockReturnValue(opts.iconLoaded)
  return mockSetImage
}

// ── Import after mocks ──
let notifyUserAttention: () => void
let stopUserAttention: () => void
let clearUserAttention: () => void
let hasActiveAttention: () => boolean
let _testInternals: any

async function reloadModule() {
  vi.resetModules()
  // hoisted vi.mock calls (top-level) persist across resetModules, no need to re-apply
  const mod = await import('../../src/main/attention')
  notifyUserAttention = mod.notifyUserAttention
  stopUserAttention = mod.stopUserAttention
  clearUserAttention = mod.clearUserAttention
  hasActiveAttention = mod.hasActiveAttention
  _testInternals = mod._testInternals
}

beforeEach(async () => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  const mockImage = {
    isEmpty: () => false,
    getSize: () => ({width: 256, height: 256}),
    toBitmap: () => Buffer.alloc(256 * 256 * 4, 128),
  }
  mockCreateFromPath.mockReturnValue(mockImage)
  mockCreateFromBitmap.mockReturnValue(mockImage)
  setupWindow({visible: true, minimized: false})
  setupTray({exists: true, iconLoaded: true})
  await reloadModule()
})

afterEach(() => {
  vi.useRealTimers()
})

// ── 引用计数测试 ──

describe('reference counting', () => {
  it('hasActiveAttention returns false initially', () => {
    expect(hasActiveAttention()).toBe(false)
  })

  it('notifyUserAttention sets active on first call (0→1)', () => {
    notifyUserAttention()
    expect(hasActiveAttention()).toBe(true)
  })

  it('notifyUserAttention does not restart on second call (1→2)', () => {
    // Force Windows path: startBlinking calls createFromPath synchronously
    // (buildHighlightIcon + originalTrayImage), so callCount > 0 gives a
    // real assertion unlike mockSetImage which only fires inside setInterval.
    Object.defineProperty(process, 'platform', {value: 'win32', configurable: true})
    setupWindow({visible: false, minimized: false})
    notifyUserAttention()
    const callCount = mockCreateFromPath.mock.calls.length
    notifyUserAttention()
    // 第二次调用不应触发新的 startBlinking（startBlinking 只会在 0→1 时执行）
    expect(mockCreateFromPath.mock.calls.length).toBe(callCount)
    expect(hasActiveAttention()).toBe(true)
  })

  it('stopUserAttention decrements; only stops at zero', () => {
    setupWindow({visible: false, minimized: false})
    notifyUserAttention()
    notifyUserAttention() // count = 2
    stopUserAttention()   // count = 1 → 仍在提醒
    expect(hasActiveAttention()).toBe(true)
    expect(_testInternals._blinkTimer).not.toBeNull()

    stopUserAttention()   // count = 0 → 停止
    expect(hasActiveAttention()).toBe(false)
    expect(_testInternals._blinkTimer).toBeNull()
  })

  it('stopUserAttention is idempotent at zero', () => {
    expect(() => stopUserAttention()).not.toThrow()
    expect(() => stopUserAttention()).not.toThrow()
    expect(hasActiveAttention()).toBe(false)
  })

  it('clearUserAttention unconditionally clears', () => {
    notifyUserAttention()
    notifyUserAttention() // count = 2
    clearUserAttention()  // 无条件清零
    expect(hasActiveAttention()).toBe(false)
    expect(_testInternals._blinkTimer).toBeNull()
  })
})

// ── 可见窗口测试 ──

describe('visible window', () => {
  it('does nothing when window is visible', () => {
    setupWindow({visible: true, minimized: false})
    notifyUserAttention()
    expect(mockFlashFrame).not.toHaveBeenCalled()
    expect(mockSetImage).not.toHaveBeenCalled()
    expect(mockNotificationShow).not.toHaveBeenCalled()
    expect(mockDockBounce).not.toHaveBeenCalled()
  })
})

// ── Windows 测试 ──

describe('windows platform', () => {
  beforeEach(() => {
    Object.defineProperty(process, 'platform', {value: 'win32', configurable: true})
  })
  afterEach(() => {
    Object.defineProperty(process, 'platform', {value: 'win32', configurable: true})
  })

  it('minimized → flashFrame(true)', () => {
    setupWindow({visible: false, minimized: true})
    notifyUserAttention()
    expect(mockFlashFrame).toHaveBeenCalledWith(true)
  })

  it('hidden to tray → tray blink', () => {
    setupWindow({visible: false, minimized: false})
    setupTray({exists: true, iconLoaded: true})
    notifyUserAttention()
    // tray.setImage is called inside setInterval(fn, 500) — advance past first tick
    vi.advanceTimersByTime(500)
    expect(mockSetImage).toHaveBeenCalled()
  })

  it('hidden to tray with no tray → flashFrame fallback', () => {
    setupWindow({visible: false, minimized: false})
    setupTray({exists: false, iconLoaded: false})
    notifyUserAttention()
    expect(mockFlashFrame).toHaveBeenCalledWith(true)
  })

  it('stopUserAttention restores original tray image', () => {
    setupWindow({visible: false, minimized: false})
    setupTray({exists: true, iconLoaded: true})
    notifyUserAttention()
    stopUserAttention()
    // 停止后应恢复原图标 (stopBlinking calls tray.setImage(originalTrayImage))
    const setImageCalls = mockSetImage.mock.calls
    expect(setImageCalls.length).toBeGreaterThan(0)
  })

  it('stopUserAttention calls flashFrame(false) when count reaches zero', () => {
    setupWindow({visible: false, minimized: true})
    notifyUserAttention()
    stopUserAttention()
    expect(mockFlashFrame).toHaveBeenCalledWith(false)
  })
})

// ── macOS 测试 ──

describe('macos platform', () => {
  beforeEach(() => {
    Object.defineProperty(process, 'platform', {value: 'darwin', configurable: true})
  })
  afterEach(() => {
    Object.defineProperty(process, 'platform', {value: 'win32', configurable: true})
  })

  it('hidden → dock.bounce critical', () => {
    setupWindow({visible: false, minimized: false})
    notifyUserAttention()
    expect(mockDockBounce).toHaveBeenCalledWith('critical')
  })
})

// ── Linux 测试 ──

describe('linux platform', () => {
  beforeEach(() => {
    Object.defineProperty(process, 'platform', {value: 'linux', configurable: true})
  })
  afterEach(() => {
    Object.defineProperty(process, 'platform', {value: 'win32', configurable: true})
  })

  it('hidden → flashFrame(true) + notification', () => {
    setupWindow({visible: false, minimized: false})
    notifyUserAttention()
    expect(mockFlashFrame).toHaveBeenCalledWith(true)
    expect(mockNotificationShow).toHaveBeenCalledTimes(1)
  })

  it('notification only sent once', () => {
    setupWindow({visible: false, minimized: false})
    notifyUserAttention()
    notifyUserAttention()
    expect(mockNotificationShow).toHaveBeenCalledTimes(1)
  })
})
