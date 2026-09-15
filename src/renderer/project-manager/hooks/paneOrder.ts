// src/renderer/project-manager/hooks/paneOrder.ts
// 三面板列顺序的持久化（PM 窗口拖动标题栏交换 文件树 / 编辑区 / 变更列表）。
//
// 存储形状：复用既有 `pm:layout:<workspacePath>` 通道，只多一个**可选**字段 `order`。
// 不新增 storage key —— 与尺寸共用一条记录，写入一律走 patchPaneLayout（read-modify-write），
// 因此尺寸写入不会擦掉 order，order 写入也不会擦掉尺寸（配套回归用例见 paneOrder.test.tsx）。
import {useCallback, useRef, useState} from 'react'
import {paneLayoutKey, patchPaneLayout} from './usePaneSize'

/** 参与排序的三个面板 id（editor 恒为唯一弹性列） */
export const PANE_IDS = ['fileTree', 'editor', 'changes'] as const
export type PaneId = (typeof PANE_IDS)[number]

/** 默认顺序 = 改造前的视觉顺序（fileTree | editor | changes） */
export const DEFAULT_ORDER: PaneId[] = ['fileTree', 'editor', 'changes']

function isPaneId(v: unknown): v is PaneId {
  return typeof v === 'string' && (PANE_IDS as readonly string[]).includes(v)
}

/**
 * 容错裁定：**任何异常一律整体回落默认顺序**。
 *
 * 非法 JSON / 非数组 / 长度 ≠ 3 / 含未知 id / 含重复 id —— 全是「这条记录被写坏了」的同一类信号。
 * 3 元素是一个固定集合，「过滤非法项再补齐」只会造出半修复的中间态（例如把 ['editor','editor','changes']
 * 补成什么？）且需要额外分支；严格整体回落实现更短、状态空间更小。
 */
export function normalizeOrder(raw: unknown): PaneId[] {
  if (!Array.isArray(raw) || raw.length !== PANE_IDS.length) return [...DEFAULT_ORDER]
  const seen = new Set<string>()
  for (const v of raw) {
    if (!isPaneId(v) || seen.has(v)) return [...DEFAULT_ORDER]
    seen.add(v)
  }
  // 三个元素、互不重复、全部来自 PANE_IDS（大小 = 3）⇒ 必是 PANE_IDS 的一个排列
  return raw as PaneId[]
}

/** 读取失败 / 无记录 / 值非法一律回落默认顺序，绝不抛错。 */
export function readPaneOrder(workspacePath: string): PaneId[] {
  if (!workspacePath) return [...DEFAULT_ORDER]
  let raw: string | null
  try {
    raw = localStorage.getItem(paneLayoutKey(workspacePath))
  } catch {
    return [...DEFAULT_ORDER]   // 隐私模式 / 存储被禁用
  }
  if (!raw) return [...DEFAULT_ORDER]
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return [...DEFAULT_ORDER]
    return normalizeOrder((parsed as {order?: unknown}).order)
  } catch {
    return [...DEFAULT_ORDER]
  }
}

/** 只合并 order 键写回（不覆盖 sizes / gitCollapsed / 另一个 usePaneSize 实例管的键）。 */
export function patchPaneOrder(workspacePath: string, order: PaneId[]): void {
  patchPaneLayout(workspacePath, {order})
}

interface UsePaneOrderResult {
  order: PaneId[]
  /** 拖动结束提交一次（内部归一化并持久化） */
  commitOrder(next: PaneId[]): void
}

/**
 * 顺序天然按 workspace 分键存储 → 切换仓库即读它自己的值，新仓库无记录 ⇒ 默认顺序，
 * 因此**不需要**显式重置。写法与 usePaneSize 一致：渲染期比对 wsRef，发现 ws 变了就重读。
 */
export function usePaneOrder(workspacePath: string): UsePaneOrderResult {
  const wsRef = useRef(workspacePath)
  const [order, setOrder] = useState<PaneId[]>(() => readPaneOrder(workspacePath))

  if (workspacePath !== wsRef.current) {
    wsRef.current = workspacePath
    setOrder(readPaneOrder(workspacePath))
  }

  const commitOrder = useCallback((next: PaneId[]) => {
    const normalized = normalizeOrder(next)
    setOrder(normalized)
    patchPaneOrder(wsRef.current, normalized)
  }, [])

  return {order, commitOrder}
}
