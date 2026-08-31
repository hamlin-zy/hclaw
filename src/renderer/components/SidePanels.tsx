import MemoPanel from './memo/MemoPanel'

/**
 * 侧边面板容器 - 备忘录面板（Task 8 MemoPanel）。
 */
export default function SidePanels() {
    return (
        <div className="relative flex flex-col overflow-hidden h-full">
            {/* 备忘录面板 */}
            <div className="h-full" id="memo-panel-placeholder">
                <MemoPanel/>
            </div>
        </div>
    )
}
