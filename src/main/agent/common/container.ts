/**
 * 简单的依赖注入容器
 *
 * 用于替代全局单例，提升可测试性
 */

export const DI_TOKENS = {
    SkillRegistry: Symbol('SkillRegistry'),
    ToolRegistry: Symbol('ToolRegistry'),
    HookEngine: Symbol('HookEngine'),
    RuntimeConfig: Symbol('RuntimeConfig'),
    ConfigBridge: Symbol('ConfigBridge'),
} as const

type Token = typeof DI_TOKENS[keyof typeof DI_TOKENS]

class DIContainer {
    private services = new Map<Token | string, unknown>()
    private factories = new Map<Token | string, () => unknown>()

    register<T>(token: Token | string, instance: T): void {
        this.services.set(token, instance)
    }

    registerFactory<T>(token: Token | string, factory: () => T): void {
        this.factories.set(token, factory)
    }

    get<T>(token: Token | string): T {
        if (this.services.has(token)) {
            return this.services.get(token) as T
        }
        if (this.factories.has(token)) {
            const instance = this.factories.get(token)!()
            this.services.set(token, instance)
            return instance as T
        }
        throw new Error(`Service not registered: ${String(token)}`)
    }

    // 替换已注册的服务（用于测试）
    replace<T>(token: Token | string, instance: T): void {
        this.services.set(token, instance)
    }

    // 清空容器（用于测试）
    reset(): void {
        this.services.clear()
    }

    // 移除已注册的服务（用于测试）
    remove(token: Token | string): void {
        this.services.delete(token)
    }
}

export const container = new DIContainer()

// 便捷方法
export function getService<T>(token: Token | string): T {
    return container.get<T>(token)
}