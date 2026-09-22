/**
 * CapabilityBadge - 已选能力徽标
 *
 * 选中能力后显示在 InputArea 输入框上方，提示用户当前已绑定能力。
 * 用户在主输入框写正文，回车发送时正文作为命令 args 填入模板。
 *
 * 交互：
 * - 点击徽标本体 → 重开 CommandPalette（切换能力）
 * - 点击 × → 清除已选能力
 */
import React from 'react'
import {AgentIcon, CommandIcon, PluginIcon, SkillIcon} from '../icons'
import type {IconProps} from '../icons'

/** 已选能力（CommandPalette 选中后内联到输入框）。
 *  ★ 定义在本组件：InputArea 反向 type-only 引入（原定义在 InputArea，
 *    徽标组件反向依赖页面组件会形成类型环）。 */
export interface SelectedCapability {
    commandId: string
    /** 展平后的能力类型；DisplayCommand.source 的 'user'（用户命令）已在 CommandPalette 归一化为 'command' */
    type: 'command' | 'plugin' | 'skill' | 'agent'
    name: string
}

interface CapabilityBadgeProps {
    capability: SelectedCapability
    onClear: () => void
    onClick: () => void
}

/** 类型 → 文字标签（与 CapabilityPicker BUCKET_LABEL 对齐）；仅用于无障碍朗读，不再视觉呈现 */
const TYPE_LABEL: Record<SelectedCapability['type'], string> = {
    command: '命令',
    plugin: '插件命令',
    skill: 'Skill',
    agent: 'Agent',
}

/** 类型 → 专用图标（icon 库单一描边风格；与 CommandList / MemoPanel 的类型图标口径一致） */
const TYPE_ICON: Record<SelectedCapability['type'], React.ComponentType<IconProps>> = {
    command: CommandIcon,
    plugin: PluginIcon,
    skill: SkillIcon,
    agent: AgentIcon,
}

export function CapabilityBadge({ capability, onClear, onClick }: CapabilityBadgeProps) {
    const label = TYPE_LABEL[capability.type]
    const Icon = TYPE_ICON[capability.type]
    return (
        <div
            data-name="capability-badge"
            onClick={onClick}
            // self-start：外层为 flex-col 布局，默认 align-items:stretch 会把子项横向拉满整行；改为按内容自适应，避免徽章横跨输入框宽度
            // mb-2：与下方 InputArea 输入框留出间距（与 AttachedFilesBar 的下间距同一档）
            // rounded-full：胶囊形；左右内距刻意不等（pl-2.5 > pr-1.5）—— 右端是弧线、视觉重量内缩，
            //   两侧同值时右侧看着更空（实测见 demo/capability-badge-pill.html）
            className="inline-flex items-center self-start gap-1.5 mb-2 pl-2.5 pr-1.5 py-1 rounded-full text-xs font-medium cursor-pointer bg-[color-mix(in_srgb,var(--brand-primary)_10%,transparent)] text-[var(--text-brand)] border border-[color-mix(in_srgb,var(--brand-primary)_30%,transparent)] hover:bg-[color-mix(in_srgb,var(--brand-primary)_20%,transparent)] transition-colors"
        >
            {/* 类型以专用图标呈现（技能/代理/命令各有图标），不再显示「Skill / Agent / 命令」文字 */}
            <span className="shrink-0 inline-flex items-center opacity-70" aria-hidden="true">
                <Icon className="w-3.5 h-3.5"/>
            </span>
            {/* 类型信息的无障碍出口：图标 aria-hidden，朗读内容由 sr-only 文字承担 */}
            <span className="sr-only">{label}</span>
            {/* -translate-y-px：items-center 居中的是行框、不是字形墨迹，中英文字形重心低于几何中线，
                统一上移 1px 补偿（inline-block 是 transform 生效的前提，inline 元素无法位移） */}
            <span className="font-medium whitespace-nowrap inline-block -translate-y-px">{capability.name}</span>
            <button
                type="button"
                data-name="capability-badge-clear"
                onClick={(e) => { e.stopPropagation(); onClear() }}
                aria-label={`清除已选能力 ${capability.name}`}
                // 命中区 16px：-mx-0.5 抵消多出的布局宽度（净占 12px），点得着但不放大 × 两侧留白
                className="shrink-0 inline-flex items-center justify-center w-4 h-4 -mx-0.5 rounded-full hover:opacity-70"
            >
                {/* × 的 path 在 viewBox 内只占中间 50%，12px 时墨迹仅 6px 显小 → 提到 14px（墨迹 7px） */}
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                    <path d="M18 6L6 18M6 6l12 12" />
                </svg>
            </button>
        </div>
    )
}

export default CapabilityBadge
