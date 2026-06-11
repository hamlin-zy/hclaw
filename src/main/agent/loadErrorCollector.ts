/**
 * 加载错误收集器工厂
 *
 * 为 Agent / Skill 等模块提供统一的错误累积-消费模式：
 * 1. 扫描前 reset()
 * 2. 扫描中 add() 累积错误
 * 3. 扫描完成后 getAndClear() 传递给前端
 */

export function createLoadErrorCollector<T extends { timestamp: number }>() {
    let errors: T[] = []

    return {
        add(error: Omit<T, 'timestamp'>): void {
            errors.push({...error, timestamp: Date.now()} as T)
        },
        getAndClear(): T[] {
            const copy = [...errors]
            errors = []
            return copy
        },
        reset(): void {
            errors = []
        },
    }
}
