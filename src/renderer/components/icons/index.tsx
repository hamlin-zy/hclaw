/**
 * icons — 手绘 SVG 功能图标库（单一描边风格）
 *
 * 设计契约：
 *  - 纯手写 SVG，无第三方图标库依赖。
 *  - 统一 24 描边框、fill="none"、stroke="currentColor"、strokeWidth=1.75、
 *    圆头圆角连接、aria-hidden（语义由调用方 aria-label 承担）。
 *  - 尺寸完全由 className 控制，组件内部不写死 width/height。
 *  - 无 focusable、无 title、无 emoji；几何克制、无填充、视觉重量一致。
 *
 * 本文件只建立图标库，不负责替换调用点。
 */

import type {ReactNode} from 'react'

export interface IconProps {
    className?: string
}

/** 统一 SVG 外壳 — 所有图标共用同一描边语言与可访问性属性 */
function Svg({className = 'w-4 h-4', children}: IconProps & {children: ReactNode}) {
    return (
        <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.75}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            className={className}
        >
            {children}
        </svg>
    )
}

/** 文件类图标共用的页面轮廓（右上折角） */
function FileBase() {
    return (
        <>
            <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/>
            <path d="M14 3v5h5"/>
        </>
    )
}

/* ─── 能力与实体 ─────────────────────────────────────────── */

/** 技能 / 工具 — 扳手 */
export function SkillIcon({className}: IconProps) {
    return (
        <Svg className={className}>
            <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>
        </Svg>
    )
}

/** 代理 — 机器人头 */
export function AgentIcon({className}: IconProps) {
    return (
        <Svg className={className}>
            <path d="M12 8V5"/>
            <circle cx="12" cy="3.5" r="1.5"/>
            <rect width="16" height="12" x="4" y="8" rx="2"/>
            <path d="M2 14h2"/>
            <path d="M20 14h2"/>
            <path d="M15 13v2"/>
            <path d="M9 13v2"/>
        </Svg>
    )
}

/** 命令 — 终端提示符 */
export function CommandIcon({className}: IconProps) {
    return (
        <Svg className={className}>
            <path d="m4 17 6-6-6-6"/>
            <path d="M12 19h8"/>
        </Svg>
    )
}

/** 插件 — 拼图 */
export function PluginIcon({className}: IconProps) {
    return (
        <Svg className={className}>
            <path d="M8 6h3a1.5 1.5 0 1 1 3 0h3a1 1 0 0 1 1 1v3a1.5 1.5 0 1 1 0 3v3a1 1 0 0 1-1 1h-3a1.5 1.5 0 1 1-3 0h-3a1 1 0 0 1-1-1v-3a1.5 1.5 0 1 1 0-3v-3a1 1 0 0 1 1-1z"/>
        </Svg>
    )
}

/** 用户命令 — 方框内提示符 */
export function UserCommandIcon({className}: IconProps) {
    return (
        <Svg className={className}>
            <rect width="18" height="18" x="3" y="3" rx="2"/>
            <path d="m7 11 2-2-2-2"/>
            <path d="M11 13h4"/>
        </Svg>
    )
}

/* ─── 状态 ──────────────────────────────────────────────── */

/** 成功 — 圆内对勾 */
export function SuccessIcon({className}: IconProps) {
    return (
        <Svg className={className}>
            <circle cx="12" cy="12" r="9"/>
            <path d="m8.5 12.5 2.5 2.5 4.5-5"/>
        </Svg>
    )
}

/** 失败 — 圆内叉 */
export function ErrorIcon({className}: IconProps) {
    return (
        <Svg className={className}>
            <circle cx="12" cy="12" r="9"/>
            <path d="m15 9-6 6"/>
            <path d="m9 9 6 6"/>
        </Svg>
    )
}

/** 警告 — 三角感叹 */
export function WarningIcon({className}: IconProps) {
    return (
        <Svg className={className}>
            <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/>
            <path d="M12 9v4"/>
            <path d="M12 17h.01"/>
        </Svg>
    )
}

/** 信息 — 圆内 i */
export function InfoIcon({className}: IconProps) {
    return (
        <Svg className={className}>
            <circle cx="12" cy="12" r="9"/>
            <path d="M12 16v-4"/>
            <path d="M12 8h.01"/>
        </Svg>
    )
}

/** 调试 — 虫子 */
export function DebugIcon({className}: IconProps) {
    return (
        <Svg className={className}>
            <path d="m8 2 1.88 1.88"/>
            <path d="M14.12 3.88 16 2"/>
            <path d="M9 7.13v-1a3.003 3.003 0 1 1 6 0v1"/>
            <path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6"/>
            <path d="M12 20v-9"/>
            <path d="M6.53 9C4.6 8.8 3 7.1 3 5"/>
            <path d="M6 13H2"/>
            <path d="M6 17c-1.8 0-3.4-1.2-3.9-3"/>
            <path d="M17.47 9c1.93-.2 3.53-1.9 3.53-4"/>
            <path d="M18 13h4"/>
            <path d="M18 17c1.8 0 3.4-1.2 3.9-3"/>
        </Svg>
    )
}

/* ─── 动作与过程 ─────────────────────────────────────────── */

/** 输出 — 向右出框箭头 */
export function OutputIcon({className}: IconProps) {
    return (
        <Svg className={className}>
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
            <path d="m16 17 5-5-5-5"/>
            <path d="M21 12H9"/>
        </Svg>
    )
}

/** 暂停 */
export function PauseIcon({className}: IconProps) {
    return (
        <Svg className={className}>
            <path d="M9.5 6v12"/>
            <path d="M14.5 6v12"/>
        </Svg>
    )
}

/** 刷新 / 重试 */
export function RefreshIcon({className}: IconProps) {
    return (
        <Svg className={className}>
            <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
            <path d="M3 3v5h5"/>
            <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/>
            <path d="M16 16h5v5"/>
        </Svg>
    )
}

/** 加载 — 沙漏 */
export function LoadingIcon({className}: IconProps) {
    return (
        <Svg className={className}>
            <path d="M5 22h14"/>
            <path d="M5 2h14"/>
            <path d="M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22"/>
            <path d="M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2"/>
        </Svg>
    )
}

/** 已匹配 — 靶心 */
export function TargetIcon({className}: IconProps) {
    return (
        <Svg className={className}>
            <circle cx="12" cy="12" r="10"/>
            <circle cx="12" cy="12" r="6"/>
            <circle cx="12" cy="12" r="2"/>
        </Svg>
    )
}

/** 对话 — 消息气泡 */
export function ChatIcon({className}: IconProps) {
    return (
        <Svg className={className}>
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
        </Svg>
    )
}

/* ─── 信息与资源 ─────────────────────────────────────────── */

/** 参考文档 — 摊开的书 */
export function BookIcon({className}: IconProps) {
    return (
        <Svg className={className}>
            <path d="M12 7v14"/>
            <path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/>
        </Svg>
    )
}

/** 执行日志 / 清单 — 剪贴板 */
export function ClipboardIcon({className}: IconProps) {
    return (
        <Svg className={className}>
            <rect width="8" height="4" x="8" y="2" rx="1"/>
            <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>
            <path d="M12 11h4"/>
            <path d="M12 16h4"/>
            <path d="M8 11h.01"/>
            <path d="M8 16h.01"/>
        </Svg>
    )
}

/** 执行结果 / 图表 — 柱状图 */
export function ChartIcon({className}: IconProps) {
    return (
        <Svg className={className}>
            <path d="M4 4v16h16"/>
            <path d="M8 16v-4"/>
            <path d="M12 16V9"/>
            <path d="M16 16V6"/>
        </Svg>
    )
}

/** 执行时间 / 计时 — 时钟 */
export function ClockIcon({className}: IconProps) {
    return (
        <Svg className={className}>
            <circle cx="12" cy="12" r="9"/>
            <path d="M12 7v5l3 2"/>
        </Svg>
    )
}

/** 快捷键 — 键盘 */
export function KeyboardIcon({className}: IconProps) {
    return (
        <Svg className={className}>
            <rect width="18" height="12" x="3" y="6" rx="2"/>
            <path d="M6 10h.01"/>
            <path d="M9 10h.01"/>
            <path d="M12 10h.01"/>
            <path d="M15 10h.01"/>
            <path d="M18 10h.01"/>
            <path d="M7 14h10"/>
        </Svg>
    )
}

/** 空格键提示 */
export function SpaceKeyIcon({className}: IconProps) {
    return (
        <Svg className={className}>
            <rect width="18" height="8" x="3" y="8" rx="1.5"/>
            <path d="M8 13h8"/>
        </Svg>
    )
}

/** 通用设置 — 滑杆 */
export function SettingsIcon({className}: IconProps) {
    return (
        <Svg className={className}>
            <path d="M4 6h6"/>
            <path d="M14 6h6"/>
            <path d="M12 4v4"/>
            <path d="M4 12h10"/>
            <path d="M18 12h2"/>
            <path d="M16 10v4"/>
            <path d="M4 18h2"/>
            <path d="M10 18h10"/>
            <path d="M8 16v4"/>
        </Svg>
    )
}

/** 模型参数 — 大脑 */
export function BrainIcon({className}: IconProps) {
    return (
        <Svg className={className}>
            <path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/>
            <path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/>
            <path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4"/>
            <path d="M17.599 6.5a3 3 0 0 0 .399-1.375"/>
            <path d="M6.003 5.125A3 3 0 0 0 6.401 6.5"/>
            <path d="M3.477 10.896a4 4 0 0 1 .585-.396"/>
            <path d="M19.938 10.5a4 4 0 0 1 .585.396"/>
            <path d="M6 18a4 4 0 0 1-1.967-.516"/>
            <path d="M19.967 17.484A4 4 0 0 1 18 18"/>
        </Svg>
    )
}

/** 渠道 / 链接 */
export function LinkIcon({className}: IconProps) {
    return (
        <Svg className={className}>
            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
        </Svg>
    )
}

/** 全局 — 地球 */
export function GlobeIcon({className}: IconProps) {
    return (
        <Svg className={className}>
            <circle cx="12" cy="12" r="10"/>
            <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/>
            <path d="M2 12h20"/>
        </Svg>
    )
}

/** 子 Agent — 分叉 */
export function SplitIcon({className}: IconProps) {
    return (
        <Svg className={className}>
            <path d="M12 4v5"/>
            <path d="M12 9 6 15v5"/>
            <path d="m12 9 6 6v5"/>
        </Svg>
    )
}

/** 面板与窗口 — 布局 */
export function LayoutIcon({className}: IconProps) {
    return (
        <Svg className={className}>
            <rect width="18" height="18" x="3" y="3" rx="2"/>
            <path d="M3 9h18"/>
            <path d="M9 21V9"/>
        </Svg>
    )
}

/** 聚合 / 分组 — 层叠 */
export function GroupIcon({className}: IconProps) {
    return (
        <Svg className={className}>
            <path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/>
            <path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/>
            <path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/>
        </Svg>
    )
}

/* ─── 目录与附件 ─────────────────────────────────────────── */

/** 附件 — 回形针 */
export function AttachmentIcon({className}: IconProps) {
    return (
        <Svg className={className}>
            <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>
        </Svg>
    )
}

/** 目录 — 文件夹 */
export function FolderIcon({className}: IconProps) {
    return (
        <Svg className={className}>
            <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>
        </Svg>
    )
}

/** 移除 — 叉 */
export function RemoveIcon({className}: IconProps) {
    return (
        <Svg className={className}>
            <path d="M18 6 6 18"/>
            <path d="m6 6 12 12"/>
        </Svg>
    )
}

/* ─── 文件类型 ──────────────────────────────────────────── */

/** 图片文件 */
export function ImageFileIcon({className}: IconProps) {
    return (
        <Svg className={className}>
            <FileBase/>
            <circle cx="10.5" cy="13" r="1.25"/>
            <path d="m8.5 17.5 2.5-3 2 2 1.5-1.5 1.5 1.5"/>
        </Svg>
    )
}

/** 代码文件 */
export function CodeFileIcon({className}: IconProps) {
    return (
        <Svg className={className}>
            <FileBase/>
            <path d="m9.5 13-1.5 2 1.5 2"/>
            <path d="m14.5 13 1.5 2-1.5 2"/>
        </Svg>
    )
}

/** 文档文件 */
export function DocFileIcon({className}: IconProps) {
    return (
        <Svg className={className}>
            <FileBase/>
            <path d="M9 12h6"/>
            <path d="M9 15h6"/>
            <path d="M9 18h4"/>
        </Svg>
    )
}

/** 表格 / 数据文件 */
export function DataFileIcon({className}: IconProps) {
    return (
        <Svg className={className}>
            <FileBase/>
            <rect width="6" height="6" x="9" y="11.5" rx="0.5"/>
            <path d="M9 14.5h6"/>
            <path d="M12 11.5v6"/>
        </Svg>
    )
}

/** 压缩包 */
export function ArchiveFileIcon({className}: IconProps) {
    return (
        <Svg className={className}>
            <FileBase/>
            <path d="M10.75 11h2.5"/>
            <path d="M12 13.25v1.25"/>
            <path d="M12 16.5v1.25"/>
        </Svg>
    )
}

/** 脚本 */
export function ScriptFileIcon({className}: IconProps) {
    return (
        <Svg className={className}>
            <FileBase/>
            <path d="m10 13 1.5 2-1.5 2"/>
            <path d="M13.5 17h2"/>
        </Svg>
    )
}

/** 视频文件 */
export function VideoFileIcon({className}: IconProps) {
    return (
        <Svg className={className}>
            <FileBase/>
            <path d="m10.5 12.75 4 2.5-4 2.5z"/>
        </Svg>
    )
}

/** 音频文件 */
export function AudioFileIcon({className}: IconProps) {
    return (
        <Svg className={className}>
            <FileBase/>
            <circle cx="11" cy="16.5" r="1.5"/>
            <path d="M12.5 16.5V10"/>
            <path d="M12.5 10c1.5.5 2.5 1.5 2.5 3"/>
        </Svg>
    )
}

/** 文本 — 空白页面 */
export function TextFileIcon({className}: IconProps) {
    return (
        <Svg className={className}>
            <FileBase/>
        </Svg>
    )
}

/** 样式文件 */
export function PaletteFileIcon({className}: IconProps) {
    return (
        <Svg className={className}>
            <FileBase/>
            <path d="M12 10.5c-1.6 1.7-2.7 3.1-2.7 4.6a2.7 2.7 0 0 0 5.4 0c0-1.5-1.1-2.9-2.7-4.6z"/>
        </Svg>
    )
}

/** 网页文件 */
export function WebFileIcon({className}: IconProps) {
    return (
        <Svg className={className}>
            <FileBase/>
            <circle cx="12" cy="14" r="3"/>
            <path d="M9 14h6"/>
            <path d="M12 11a1.5 3 0 1 0 0 6 1.5 3 0 1 0 0-6"/>
        </Svg>
    )
}

/** 图片 / 媒体 — 相框 */
export function MediaFileIcon({className}: IconProps) {
    return (
        <Svg className={className}>
            <rect width="18" height="16" x="3" y="4" rx="2"/>
            <circle cx="8.5" cy="9" r="1.5"/>
            <path d="m6 18 5-5 3 3 2-2 4 4"/>
        </Svg>
    )
}

/* ─── 会话与工具调用 ─────────────────────────────────────── */

/** 思考内容 — 灯泡 */
export function ThinkingIcon({className}: IconProps) {
    return (
        <Svg className={className}>
            <path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1.3.5 2.6 1.5 3.5.8.8 1.3 1.5 1.5 2.5"/>
            <path d="M9 18h6"/>
            <path d="M10 22h4"/>
        </Svg>
    )
}

/** 工具调用 — 锤子 */
export function ToolIcon({className}: IconProps) {
    return (
        <Svg className={className}>
            <path d="M12.8 4.2 19.8 11.2 17.7 13.3 10.7 6.3z"/>
            <path d="M14.2 9.8 4.8 19.2"/>
        </Svg>
    )
}
