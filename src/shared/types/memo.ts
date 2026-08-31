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
}
