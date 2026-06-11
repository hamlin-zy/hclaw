/**
 * ChannelIcons — 各渠道官方应用风格 SVG 图标
 * 用于会话列表区分渠道来源，以及 ChannelsDialog 渠道类型标识
 */
import type {ChannelType} from '@shared/types'

type IconProps = { className?: string; size?: number }

/** 飞书官方图标风格 — 蓝色折纸 */
export function FeishuIcon({className, size = 16}: IconProps) {
    return (
        <svg className={className} width={size} height={size} viewBox="0 0 48 48" fill="none" aria-hidden="true">
            <rect width="48" height="48" rx="12" fill="#3370FF"/>
            <path
                d="M41.072 5.994L3.31 16.52l9.075 9.294l8.414.146l9.683-9.44q-.384-.787-.384-1.318c0-.794.311-1.422.796-1.868q1.244-1.145 2.994-.342z"
                fill="white" opacity="0.9"/>
            <path
                d="M42.102 6.728L31.578 44.49l-9.295-9.076l-.147-8.414l9.375-9.518a2.54 2.54 0 0 0 1.664.495c.902-.05 1.485-.596 1.759-.917a2.35 2.35 0 0 0 .567-1.649a2.57 2.57 0 0 0-.52-1.464z"
                fill="white" opacity="0.7"/>
        </svg>
    )
}

/** 微信官方图标风格 — simple-icons 双气泡带眼 */
export function WeChatIcon({className, size = 16}: IconProps) {
    return (
        <svg className={className} width={size} height={size} viewBox="0 0 48 48" fill="none" aria-hidden="true">
            <rect width="48" height="48" rx="12" fill="#07C160"/>
            <g transform="scale(2)">
                <path
                    d="M8.691 2.188C3.891 2.188 0 5.476 0 9.53c0 2.212 1.17 4.203 3.002 5.55a.59.59 0 0 1 .213.665l-.39 1.48c-.019.07-.048.141-.048.213 0 .163.13.295.29.295a.326.326 0 0 0 .167-.054l1.903-1.114a.864.864 0 0 1 .717-.098 10.16 10.16 0 0 0 2.837.403c.276 0 .543-.027.811-.05-.857-2.578.157-4.972 1.932-6.446 1.703-1.415 3.882-1.98 5.853-1.838-.576-3.583-4.196-6.348-8.596-6.348zM5.785 5.991c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178A1.17 1.17 0 0 1 4.623 7.17c0-.651.52-1.18 1.162-1.18zm5.813 0c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178 1.17 1.17 0 0 1-1.162-1.178c0-.651.52-1.18 1.162-1.18zm5.34 2.867c-1.797-.052-3.746.512-5.28 1.786-1.72 1.428-2.687 3.72-1.78 6.22.942 2.453 3.666 4.229 6.884 4.229.826 0 1.622-.12 2.361-.336a.722.722 0 0 1 .598.082l1.584.926a.272.272 0 0 0 .14.047c.134 0 .24-.111.24-.247 0-.06-.023-.12-.038-.177l-.327-1.233a.582.582 0 0 1-.023-.156.49.49 0 0 1 .201-.398C23.024 18.48 24 16.82 24 14.98c0-3.21-2.931-5.837-6.656-6.088V8.89c-.135-.01-.27-.027-.407-.03zm-2.53 3.274c.535 0 .969.44.969.982a.976.976 0 0 1-.969.983.976.976 0 0 1-.969-.983c0-.542.434-.982.97-.982zm4.844 0c.535 0 .969.44.969.982a.976.976 0 0 1-.969.983.976.976 0 0 1-.969-.983c0-.542.434-.982.969-.982z"
                    fill="white"/>
            </g>
        </svg>
    )
}

/** 桌面端默认图标 — 终端窗口 */
export function DesktopIcon({className, size = 16}: IconProps) {
    return (
        <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <rect x="2" y="3" width="20" height="14" rx="2"/>
            <line x1="8" y1="21" x2="16" y2="21"/>
            <line x1="12" y1="17" x2="12" y2="21"/>
            <polyline points="7 8 10 11 7 14"/>
        </svg>
    )
}

/** 根据 channelType 渲染对应图标 */
export function ChannelTypeIcon({type, className, size}: { type?: ChannelType | null } & IconProps) {
    switch (type) {
        case 'wechat': return <WeChatIcon className={className} size={size}/>;
        case 'feishu': return <FeishuIcon className={className} size={size}/>;
        default: return <DesktopIcon className={className} size={size}/>;
    }
}

/** 渠道名称中文 */
export const CHANNEL_LABELS: Record<ChannelType, string> = {
    wechat: '个人微信',
    feishu: '飞书',
}
