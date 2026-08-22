import PermissionRulesPanel from './PermissionRulesPanel'
import {useSidebarStore} from '../stores/sidebarStore'

/**
 * 侧边面板容器 - 权限规则面板。
 *
 * （待办列表已移至 InputArea 顶部，见 TodoStrip.tsx）
 */
export default function SidePanels() {
    const {setRightCollapsed} = useSidebarStore()

    return (
        <div className="relative flex flex-col overflow-hidden h-full">
            {/* 权限规则面板 */}
            <PermissionRulesPanel height="100%"/>

            {/* 左侧边缘折叠按钮 */}
            <button
                onClick={() => setRightCollapsed(true)}
                aria-label="折叠右侧面板"
                className="absolute top-0 h-full flex items-center z-50"
                style={{left: '-24px'}}
            >
                <div
                    className="w-6 h-20 rounded-l flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--brand-primary)] hover:bg-[var(--surface-muted)] transition-colors">
                    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                         strokeWidth="2">
                        <polyline points="9 18 15 12 9 6"/>
                    </svg>
                </div>
            </button>
        </div>
    )
}
