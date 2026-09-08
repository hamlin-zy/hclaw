/**
 * 备忘录类型定义（spec: docs/superpowers/specs/2026-08-29-memo-feature-design.md §3）
 */
export type MemoCapabilityType = 'agent' | 'skill' | 'command'

export interface MemoCapability {
    type: MemoCapabilityType
    name: string
    commandId?: string
}

export interface MemoAttachment {
    id: string
    fileName: string
    storedPath: string
    mime: string
    kind: 'image' | 'file'
}

export type MemoPriority = 'urgent' | 'high' | 'normal' | 'low'

/** 优先级权重：数值越小优先级越高（undefined / normal = 1） */
export const MEMO_PRIORITY_WEIGHT: Record<MemoPriority, number> = {
    urgent: 0,
    high: 1,
    normal: 2,
    low: 3,
}

export interface MemoItem {
    id: string
    workspacePath: string
    title: string
    content: string
    createdAt: number
    updatedAt: number
    capability?: MemoCapability
    attachments: MemoAttachment[]
    status: 'active' | 'processed'
    relatedConvId?: string
    /** 置顶标记（仅 active 组内生效；标记 processed 时自动清除） */
    pinned?: boolean
    /** 组内手动排序序号（拖拽后组内重编号 1..n，desc 排序；默认 0） */
    sortIndex?: number
    /** 优先级（缺省视为 normal，老数据无需迁移） */
    priority?: MemoPriority
}
