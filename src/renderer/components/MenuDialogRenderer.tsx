import {useEffect, useState} from 'react'
import {useMenuBarStore} from '../stores/menuBarStore'
import MenuDialog from './MenuDialog'
import UpdateNoticeDialog from './dialogs/UpdateNoticeDialog'

interface DialogConfig {
    title: string
    Component: React.ComponentType
    /** 面板宽度 -> 居中 Modal 换算规则：统一按现有 initialWidth 或 widthRatio 取合适 maxWidth */
    initialWidth?: number
    widthRatio?: number
    /** 面板最小宽度，默认 420 */
    minWidth?: number
    /** 面板初始高度（不设则默认 85vh） */
    initialHeight?: number
}

const DIALOG_CONFIG: Record<string, DialogConfig> = {
    'update-notice': {title: '更新通知', Component: UpdateNoticeDialog, initialWidth: 380, minWidth: 340, initialHeight: 360},
}

/** 根据当前视图宽度和配置，计算居中 Modal 的实际最大宽度 */
function calcModalWidth(config: DialogConfig): number {
    const base = config.initialWidth ?? (config.widthRatio ? Math.floor(window.innerWidth * config.widthRatio) : 480)
    const minW = config.minWidth ?? 420
    return Math.max(minW, Math.min(Math.floor(window.innerWidth * 0.9), base))
}

export default function MenuDialogRenderer() {
    const { activeDialog, dialogOrigin, closeDialog } = useMenuBarStore()
    // 用 key 强制 Dialog 组件在 activeDialog 变更时完全重挂载
    const [, setTick] = useState(0)

    const config = activeDialog ? DIALOG_CONFIG[activeDialog] : null

    // 窗口 resize 时重新计算宽度
    const [modalWidth, setModalWidth] = useState(480)
    useEffect(() => {
        if (!config) return
        setModalWidth(calcModalWidth(config))
        const onResize = () => setModalWidth(calcModalWidth(config))
        window.addEventListener('resize', onResize)
        return () => window.removeEventListener('resize', onResize)
    }, [activeDialog, config])

    // 点击不同按钮切换 Dialog 时，产生一个 side effect 让 AnimatePresence 触发 exit/enter
    useEffect(() => {
        setTick(n => n + 1)
    }, [activeDialog])

    return (
        <MenuDialog
            isOpen={!!config}
            title={config?.title ?? ''}
            onClose={closeDialog}
            origin={dialogOrigin}
            maxWidth={modalWidth}
            minWidth={config?.minWidth ?? 420}
            initialHeight={config?.initialHeight}
            dialogKey={activeDialog ?? undefined}
        >
            {config && <config.Component />}
        </MenuDialog>
    )
}
