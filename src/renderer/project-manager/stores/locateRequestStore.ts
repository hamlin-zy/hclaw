// 「定位到某行」的请求通道 —— **工单 06 的接缝，本工单只发不收**。
//
// 谁写：QuickOpen 的打开流程（工单 05）——Find in Files 回车打开文件后调 `requestLocate(path, line)`。
// 谁读：编辑器侧（工单 06 的 agent），在 `EditorArea` / `CodeEditor` 消费本 store：
//   监听 `seq` 变化 → 若 `path` 等于当前激活 tab 的 filePath，则滚动使 `line` 居中、
//   光标置该行行首、1500ms 高亮后硬清除；用户手动行选中时立即清除定位高亮。
//
// 为什么用 `seq` 而不是「比较 path/line 是否变化」：**重复定位到同一行也要能触发一次**，
// 否则「再次打开同一处」在编辑器侧看起来什么都没发生。seq 单调前进，下游据此区分「又是一次定位」。
// 该契约与 spec §定位 一致（重复定位只重置计时、不重新滚动，由下游自行判断）。
import {create} from 'zustand'

export interface LocateRequestState {
    /** 工作区相对路径（统一 '/'）；null = 尚无请求 */
    path: string | null
    /** 目标行号（1-based） */
    line: number
    /** 请求序号：每次 requestLocate 都前进（同路径同行号重复请求也前进） */
    seq: number
    /** 请求定位（由 QuickOpen 的打开流程调用） */
    requestLocate(path: string, line: number): void
    /** 清空（测试与浮层重开时用） */
    reset(): void
}

export const useLocateRequestStore = create<LocateRequestState>()(set => ({
    path: null,
    line: 1,
    seq: 0,

    requestLocate(path, line) {
        set(s => ({path, line: Math.max(1, Math.floor(line)), seq: s.seq + 1}))
    },

    reset() {
        set({path: null, line: 1, seq: 0})
    },
}))

/** 非组件上下文的调用入口（QuickOpen 的打开流程用；组件内也可直接用 store action） */
export function requestLocate(path: string, line: number): void {
    useLocateRequestStore.getState().requestLocate(path, line)
}
