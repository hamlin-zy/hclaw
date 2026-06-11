/**
 * 提示词解析器
 *
 * 负责管理提示词方案并按需解析。
 * 优先使用激活方案的节点覆盖，无方案时回退到代码硬编码默认值。
 */

import type {PromptNodeCategory, PromptNodeKey, PromptNodeMeta, PromptScheme} from '@shared/types'
import {ALL_PROMPT_NODES, getPromptNodeByKey} from '@shared/prompts'

// ─── Resolver 类 ──────────────────────────────────────────────

export class PromptResolver {
    private defaults: Map<PromptNodeKey, string> = new Map()
    /** 当前激活方案的节点覆盖 */
    private schemeNodes: Map<PromptNodeKey, string> = new Map()
    private enabled: boolean = true

    constructor() {
        // 初始化默认值
        for (const node of ALL_PROMPT_NODES) {
            this.defaults.set(node.key, node.defaultValue)
        }
    }

    /**
     * 解析单个节点
     * 优先使用方案覆盖，无覆盖时使用代码默认值
     */
    resolve(key: PromptNodeKey): string {
        if (!this.enabled) {
            return this.defaults.get(key) || ''
        }

        // 检查方案覆盖
        if (this.schemeNodes.has(key)) {
            const custom = this.schemeNodes.get(key)
            if (custom && custom.trim()) {
                return custom.trim()
            }
        }

        // 回退到代码默认值
        return this.defaults.get(key) || ''
    }

    /**
     * 批量解析多个节点
     */
    resolveMany(keys: PromptNodeKey[]): string[] {
        return keys.map(key => this.resolve(key))
    }

    /**
     * 加载提示词方案
     * @param scheme 要激活的方案，传 null 则重置（使用代码兜底）
     */
    loadScheme(scheme: PromptScheme | null): void {
        if (!scheme) {
            this.enabled = true
            this.schemeNodes.clear()
            return
        }

        this.enabled = scheme.enabled ?? true
        this.schemeNodes.clear()

        if (scheme.nodes) {
            for (const [key, content] of Object.entries(scheme.nodes)) {
                if (content && content.trim()) {
                    this.schemeNodes.set(key as PromptNodeKey, content.trim())
                }
            }
        }
    }

    /**
     * 获取节点元信息
     */
    getMeta(key: PromptNodeKey): PromptNodeMeta | undefined {
        return getPromptNodeByKey(key)
    }

    /**
     * 按分类获取节点列表
     */
    getNodesByCategory(category: PromptNodeCategory): PromptNodeMeta[] {
        return ALL_PROMPT_NODES.filter(node => node.category === category)
    }

    /**
     * 重置为代码默认值
     */
    reset(): void {
        this.enabled = true
        this.schemeNodes.clear()
    }

    /**
     * 检查是否有任何方案覆盖
     */
    hasCustomizations(): boolean {
        return this.schemeNodes.size > 0
    }
}

// ─── 单例导出 ─────────────────────────────────────────────

export const promptResolver = new PromptResolver()
