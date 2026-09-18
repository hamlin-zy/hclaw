import {InfoIcon} from '../../icons'

/** 信息提示（spec §4.1）：hover/focus 经 TooltipPortal 的 data-tooltip 通道；无 JS 弹层依赖 */
export default function InfoTip({text, id}: {text: string; id?: string}) {
    return (
        <>
            <span
                tabIndex={0}
                data-tooltip={text}
                aria-label={text}
                className="inline-flex items-center text-[var(--text-muted)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
            >
                <InfoIcon className="w-3 h-3"/>
            </span>
            {id && <span id={id} className="sr-only">{text}</span>}
        </>
    )
}
