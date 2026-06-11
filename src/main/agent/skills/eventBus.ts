/**
 * SkillEventBus — 技能事件总线
 *
 * 发布和订阅技能生命周期事件，用于前端 UI 实时展示技能执行状态。
 */

export type SkillEventType =
    | 'skill_matched'
    | 'skill_progress'

export interface SkillEvent {
    type: SkillEventType
    skillId: string
    skillName: string
    timestamp: number
    data?: Record<string, unknown>
}

export type SkillEventCallback = (event: SkillEvent) => void

class SkillEventBusImpl {
    private listeners: Map<SkillEventType | '*', Set<SkillEventCallback>> = new Map()
    private eventHistory: SkillEvent[] = []
    private maxHistory = 50

    on(type: SkillEventType | '*', callback: SkillEventCallback): () => void {
        if (!this.listeners.has(type)) {
            this.listeners.set(type, new Set())
        }
        this.listeners.get(type)!.add(callback)
        return () => {
            this.listeners.get(type)?.delete(callback)
        }
    }

    emit(event: SkillEvent): void {
        event.timestamp = event.timestamp || Date.now()

        this.eventHistory.push(event)
        if (this.eventHistory.length > this.maxHistory) {
            this.eventHistory = this.eventHistory.slice(-this.maxHistory)
        }

        // 通知特定类型监听器
        const callbacks = this.listeners.get(event.type)
        if (callbacks) {
            for (const cb of callbacks) {
                try {
                    cb(event)
                } catch (e) {
                    // Listener error
                }
            }
        }

        // 通知通配符监听器
        const allCallbacks = this.listeners.get('*')
        if (allCallbacks) {
            for (const cb of allCallbacks) {
                try {
                    cb(event)
                } catch (e) {
                    // Listener error
                }
            }
        }
    }

    getHistory(skillId?: string): SkillEvent[] {
        if (skillId) return this.eventHistory.filter(e => e.skillId === skillId)
        return [...this.eventHistory]
    }

    clearHistory(): void {
        this.eventHistory = []
    }

    removeAllListeners(type?: SkillEventType | '*'): void {
        if (type) this.listeners.delete(type)
        else this.listeners.clear()
    }
}

export const skillEventBus = new SkillEventBusImpl()
