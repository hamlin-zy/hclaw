// src/renderer/project-manager/hooks/usePaneSize.ts
// 分栏尺寸的 localStorage 持久化（spec §5.2 / §5.5）
// 按 workspace 分开存：不同仓库的目录结构差异很大，共用一套尺寸会互相干扰。
import {useCallback, useRef, useState} from 'react'

export interface PaneSizeSpec {
  default: number
  min: number
  max: number
}

export type PaneSizeSpecs = Record<string, PaneSizeSpec>

export interface PaneLayout {
  /** 各分栏的尺寸（px）；Git 区高度也在这里（键为 GIT_HEIGHT_KEY） */
  sizes: Record<string, number>
  gitCollapsed: boolean
  /** 折叠前记住的 Git 区高度，用于展开时还原 */
  gitHeightBeforeCollapse: number
}

/** Git 区高度在 sizes 里的键名 */
export const GIT_HEIGHT_KEY = 'gitHeight'
/** 折叠态下 Git 区的高度（spec §5.4：收成 22px 的标题条） */
export const COLLAPSED_GIT_HEIGHT = 22

/** specs 未声明 gitHeight 时的兜底高度（px） */
const DEFAULT_GIT_HEIGHT = 236

const STORAGE_PREFIX = 'pm:layout:'

export function paneLayoutKey(workspacePath: string): string {
  return STORAGE_PREFIX + workspacePath
}

/** 夹紧到 [min, max]；非有限数回落默认值。 */
export function clampPane(raw: unknown, spec: PaneSizeSpec): number {
  const n = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(n)) return spec.default
  return Math.min(spec.max, Math.max(spec.min, n))
}

export function defaultLayout(specs: PaneSizeSpecs): PaneLayout {
  return {
    sizes: Object.fromEntries(Object.entries(specs).map(([key, spec]) => [key, spec.default])),
    gitCollapsed: false,
    gitHeightBeforeCollapse: specs[GIT_HEIGHT_KEY]?.default ?? DEFAULT_GIT_HEIGHT,
  }
}

/** 读取失败 / 值非法一律回落默认值，绝不抛错。 */
export function readPaneLayout(workspacePath: string, specs: PaneSizeSpecs): PaneLayout {
  const fallback = defaultLayout(specs)
  if (!workspacePath) return fallback

  let raw: string | null
  try {
    raw = localStorage.getItem(paneLayoutKey(workspacePath))
  } catch {
    return fallback   // 隐私模式 / 存储被禁用
  }
  if (!raw) return fallback

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return fallback
  }
  if (typeof parsed !== 'object' || parsed === null) return fallback

  const stored = parsed as Partial<PaneLayout>
  const sizes: Record<string, number> = {}
  for (const [key, spec] of Object.entries(specs)) {
    sizes[key] = clampPane(stored.sizes?.[key], spec)
  }
  const gitSpec = specs[GIT_HEIGHT_KEY]
  return {
    sizes,
    gitCollapsed: stored.gitCollapsed === true,
    gitHeightBeforeCollapse: gitSpec
      ? clampPane(stored.gitHeightBeforeCollapse, gitSpec)
      : fallback.gitHeightBeforeCollapse,
  }
}

export function writePaneLayout(workspacePath: string, layout: PaneLayout): void {
  if (!workspacePath) return
  try {
    localStorage.setItem(paneLayoutKey(workspacePath), JSON.stringify(layout))
  } catch {
    /* 配额溢出 / 隐私模式：静默放弃持久化，不影响本次会话 */
  }
}

/**
 * 只更新指定的键再写回，**不覆盖其它键**。
 *
 * 为什么需要：布局由两个组件各自持有一个 usePaneSize 实例管理——
 * ProjectManagerApp 管 fileTree / changes / gitHeight，GitLogPanel 管 branches / detail。
 * 若各自整体覆盖，后写的会把先写的键擦掉。按 key 合并后两个实例互不干扰。
 */
export function patchPaneLayout(workspacePath: string, patch: Partial<PaneLayout>): void {
  if (!workspacePath) return
  try {
    const key = paneLayoutKey(workspacePath)
    const raw = localStorage.getItem(key)
    const current = raw ? (JSON.parse(raw) as Partial<PaneLayout>) : {}
    const next: Partial<PaneLayout> = {
      ...current,
      ...patch,
      sizes: {...(current.sizes ?? {}), ...(patch.sizes ?? {})},
    }
    localStorage.setItem(key, JSON.stringify(next))
  } catch {
    /* 静默放弃持久化 */
  }
}

export interface UsePaneSizeResult {
  sizes: Record<string, number>
  gitCollapsed: boolean
  /** 拖动结束 / 键盘调整时提交一次（内部夹紧并持久化） */
  commitSize(key: string, px: number): void
  setGitCollapsed(collapsed: boolean): void
}

export function usePaneSize(workspacePath: string, specs: PaneSizeSpecs): UsePaneSizeResult {
  // specs 由调用方以模块级常量传入；用 ref 取最新值，避免每次渲染重建回调
  const specsRef = useRef(specs)
  specsRef.current = specs
  const wsRef = useRef(workspacePath)

  const [layout, setLayout] = useState<PaneLayout>(() => readPaneLayout(workspacePath, specsRef.current))

  // 同一组件实例切换 workspace 时重读（window 内不一定重挂载）
  if (workspacePath !== wsRef.current) {
    wsRef.current = workspacePath
    setLayout(readPaneLayout(workspacePath, specsRef.current))
  }

  const commitSize = useCallback((key: string, px: number) => {
    setLayout(prev => {
      const spec = specsRef.current[key]
      if (!spec) return prev
      const clamped = clampPane(px, spec)
      const next: PaneLayout = {
        ...prev,
        sizes: {...prev.sizes, [key]: clamped},
        // 手动拖 Git 区高度即表示"我要看它"，顺带解除折叠
        gitCollapsed: key === GIT_HEIGHT_KEY ? false : prev.gitCollapsed,
      }
      // 按 key 合并写盘：另一个 usePaneSize 实例管的键不会被擦掉
      patchPaneLayout(wsRef.current, {
        sizes: {[key]: clamped},
        ...(key === GIT_HEIGHT_KEY ? {gitCollapsed: false} : {}),
      })
      return next
    })
  }, [])

  const setGitCollapsed = useCallback((collapsed: boolean) => {
    setLayout(prev => {
      if (prev.gitCollapsed === collapsed) return prev
      const gitSpec = specsRef.current[GIT_HEIGHT_KEY]
      const previousHeight = prev.sizes[GIT_HEIGHT_KEY] ?? gitSpec?.default ?? DEFAULT_GIT_HEIGHT
      let next: PaneLayout
      if (collapsed) {
        next = {
          ...prev,
          gitCollapsed: true,
          gitHeightBeforeCollapse: previousHeight,
          // 折叠高度低于 spec.min，必须绕过 clamp 直接赋值
          sizes: {...prev.sizes, [GIT_HEIGHT_KEY]: COLLAPSED_GIT_HEIGHT},
        }
      } else {
        next = {
          ...prev,
          gitCollapsed: false,
          sizes: {
            ...prev.sizes,
            [GIT_HEIGHT_KEY]: gitSpec
              ? clampPane(prev.gitHeightBeforeCollapse, gitSpec)
              : prev.gitHeightBeforeCollapse,
          },
        }
      }
      patchPaneLayout(wsRef.current, {
        sizes: next.sizes,
        gitCollapsed: next.gitCollapsed,
        gitHeightBeforeCollapse: next.gitHeightBeforeCollapse,
      })
      return next
    })
  }, [])

  return {sizes: layout.sizes, gitCollapsed: layout.gitCollapsed, commitSize, setGitCollapsed}
}
