interface UpdateDotProps {
    show: boolean
    /** 悬停提示文案；提供时同时作为无障碍名 */
    title?: string
}

/**
 * 「有更新」小红点：复用既有 --error 令牌，不新增 token。
 *
 * 纯展示指示器：不处理点击（点击行为由外层可交互元素负责），
 * 定位（如 absolute 挂在图标角上）由调用方的容器决定。
 */
export function UpdateDot({show, title}: UpdateDotProps) {
    if (!show) return null

    return (
        <span
            className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--error)]"
            title={title}
            aria-label={title}
            aria-hidden={title ? undefined : true}
            data-name="update-dot"
        />
    )
}
