// src/renderer/utils/memorySources.ts — 各 store 向水位监控登记规模指标
// 盯防方向（用户确认的崩溃场景）：会话级状态随消息数/会话数的线性增长。
import {registerMemorySource} from './memoryWatermark'
import {useAgentStore} from '../stores/agentStore'
import {useConversationStore} from '../stores/conversationStore'

export function registerStoreMemorySources(): void {
    registerMemorySource('agentStore', () => {
        const s = useAgentStore.getState()
        return {activeConvs: Object.keys(s.convAgentStates).length}
    })
    registerMemorySource('conversationStore', () => {
        const m = useConversationStore.getState().messagesMap
        let msgs = 0
        for (const arr of Object.values(m)) msgs += arr.length
        return {loadedConvs: Object.keys(m).length, totalMsgs: msgs}
    })
}
