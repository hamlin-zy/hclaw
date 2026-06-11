/**
 * 权限上下文管理器
 *
 * 职责：
 * 1. 管理权限模式转换（safe/plan/auto）
 * 2. 处理plan模式进入/退出时的状态保存和恢复
 * 3. 处理auto模式进入/退出时的危险规则剥离和恢复
 * 4. 持久化规则到 SQLite permission_rules 表
 * 5. 持久化配置到 SQLite system_settings 表
 *
 * 设计参考：Claude Code的transitionPermissionMode机制
 * 简化点：保持单一规则源，不支持多源规则
 */

import {logger} from '../logger'
import type {
    DangerousPermissionInfo,
    PermissionRule,
    PermissionUpdate,
    RunMode,
    ToolPermissionContext
} from '@shared/types'
import {findDangerousPermissions} from './dangerousPatterns'
import {createPermissionRepository} from '../../repositories'
import {systemSettingsRepo} from '../../repositories/sqlite/systemSettingsRepository'

/**
 * 权限上下文管理器（简化版，单一规则源）
 */
export class PermissionRulesManager {
    private context: ToolPermissionContext
    private permissionRepo = createPermissionRepository()
    private isInitialized = false

    constructor() {
        this.context = this.createDefaultContext()
        // 延迟加载：数据库初始化由 repositories/init.ts 同步完成
        // loadFromDatabase 会在第一次 getContext/getMode/getRules 时自动触发
    }

    /**
     * 确保初始化完成
     * 首次调用时会触发 loadFromDatabase()
     */
    private async ensureInit(): Promise<void> {
        if (this.isInitialized) return
        this.isInitialized = true
        await this.loadFromDatabase()
    }

    /**
     * 获取当前上下文
     */
    async getContext(): Promise<ToolPermissionContext> {
        await this.ensureInit()
        return {...this.context}
    }

    /**
     * 获取当前模式
     */
    async getMode(): Promise<RunMode> {
        await this.ensureInit()
        return this.context.mode
    }

    /**
     * 获取当前规则
     */
    async getRules(): Promise<PermissionRule[]> {
        await this.ensureInit()
        return [...this.context.rules]
    }

    /**
     * 应用权限更新
     */
    async applyUpdate(update: PermissionUpdate): Promise<ToolPermissionContext> {
        await this.ensureInit()
        let result = this.context

        switch (update.type) {
            case 'setMode':
                result = this.transitionMode(update.mode)
                break
            case 'addRule':
                result = this.addRule(update.rule)
                break
            case 'removeRule':
                result = this.removeRule(update.tool)
                break
            case 'setRules':
                result = this.setRules(update.rules)
                break
        }

        this.context = result
        await this.saveToDatabase(update)
        return this.getContext()
    }

    /**
     * 模式转换（参考CC的transitionPermissionMode，但简化）
     *
     * 状态转换逻辑：
     * - safe → plan: 保存safe为prePlanMode，进入plan模式
     * - plan → safe: 恢复prePlanMode (safe)
     * - plan → auto: 恢复prePlanMode，再进入auto（带危险规则剥离）
     * - auto → plan: 保存auto为prePlanMode，进入plan模式
     * - safe → auto: 剥离危险规则，进入auto模式
     * - auto → safe: 恢复危险规则，退出auto模式
     */
    private transitionMode(toMode: RunMode): ToolPermissionContext {
        const fromMode = this.context.mode

        // 相同模式，无操作
        if (fromMode === toMode) return this.context

        let result = {...this.context, mode: toMode}

        // === 处理Auto模式进入/退出 ===
        if (toMode === 'auto' && fromMode !== 'auto') {
            // 进入Auto：剥离危险规则
            result = this.stripDangerousRules(result)

        } else if (fromMode === 'auto' && toMode !== 'auto') {
            // 退出Auto：恢复危险规则
            result = this.restoreDangerousRules(result)
        }

        return result
    }

    /**
     * 剥离危险规则（用于auto模式）
     *
     * 参考CC的stripDangerousPermissionsForAutoMode：
     * - 检测Bash解释器模式（python:*, node:*等）
     * - 检测Agent工具的任意allow规则
     * - 将危险规则保存到strippedDangerousRules
     * - 从当前rules中移除危险规则
     */
    private stripDangerousRules(context: ToolPermissionContext): ToolPermissionContext {
        const dangerous = findDangerousPermissions(context.rules)

        if (dangerous.length === 0) {
            return {
                ...context,
                strippedDangerousRules: context.strippedDangerousRules ?? []
            }
        }

        // 存储被剥离的规则
        const strippedRules = dangerous.map(d => d.rule)

        // 从当前规则中移除危险的
        const safeRules = context.rules.filter(rule =>
            !dangerous.some(d => d.rule.tool === rule.tool)
        )

        return {
            ...context,
            rules: safeRules,
            strippedDangerousRules: strippedRules
        }
    }

    /**
     * 恢复危险规则（退出auto模式时）
     *
     * 参考CC的restoreDangerousPermissions：
     * - 从strippedDangerousRules恢复规则
     * - 与当前规则合并（去重，stripped优先）
     * - 清空strippedDangerousRules
     */
    private restoreDangerousRules(context: ToolPermissionContext): ToolPermissionContext {
        const stripped = context.strippedDangerousRules

        if (!stripped || stripped.length === 0) {
            return context
        }

        // 合并规则（去重：对于相同tool，保留stripped中的版本）
        const ruleMap = new Map<string, PermissionRule>()

        // 先添加当前规则
        for (const rule of context.rules) {
            ruleMap.set(rule.tool, rule)
        }

        // 再添加被剥离的规则（覆盖同tool的规则）
        for (const rule of stripped) {
            ruleMap.set(rule.tool, rule)
        }

        return {
            ...context,
            rules: Array.from(ruleMap.values()),
            strippedDangerousRules: undefined
        }
    }

    /**
     * 添加规则
     */
    private addRule(rule: PermissionRule): ToolPermissionContext {
        const rules = this.context.rules.filter(r => r.tool !== rule.tool)
        rule.createdAt = Date.now()
        rules.push(rule)

        return {...this.context, rules}
    }

    /**
     * 移除规则
     */
    private removeRule(tool: string): ToolPermissionContext {
        const rules = this.context.rules.filter(r => r.tool !== tool)

        return {...this.context, rules}
    }

    /**
     * 设置规则列表
     */
    private setRules(rules: PermissionRule[]): ToolPermissionContext {
        // 去重
        const ruleMap = new Map<string, PermissionRule>()
        for (const rule of rules) {
            if (!rule.createdAt) {
                rule.createdAt = Date.now()
            }
            ruleMap.set(rule.tool, rule)
        }

        return {...this.context, rules: Array.from(ruleMap.values())}
    }

    /**
     * 创建默认上下文
     */
    private createDefaultContext(): ToolPermissionContext {
        return {
            mode: 'safe',
            rules: [],
            additionalWorkingDirectories: [],
            isBypassPermissionsModeAvailable: false,
            isAutoModeAvailable: true,
        }
    }

    /**
     * 从 SQLite 加载规则和配置
     */
    private async loadFromDatabase(): Promise<void> {
        let rules: PermissionRule[] = []
        try {
            rules = this.permissionRepo.getRules()
        } catch (err) {
            logger.error('[PermissionRulesManager] loadFromDatabase: failed to load rules', {error: err})
        }

        // 加载配置（mode、prePlanMode、strippedDangerousRules）
        let mode: RunMode = 'safe'
        let prePlanMode: RunMode | undefined = undefined
        let strippedDangerousRules: PermissionRule[] | undefined = undefined

        try {
            const modeValue = systemSettingsRepo.get('permission_mode')
            if (modeValue) mode = modeValue as RunMode

            const prePlanModeValue = systemSettingsRepo.get('permission_pre_plan_mode')
            if (prePlanModeValue) prePlanMode = prePlanModeValue as RunMode

            const strippedValue = systemSettingsRepo.get('permission_stripped_dangerous_rules')
            if (strippedValue) {
                try {
                    strippedDangerousRules = JSON.parse(strippedValue)
                } catch {
                }
            }
        } catch (err) {
            logger.error('[PermissionRulesManager] loadFromDatabase: failed to load config', {error: err})
        }

        this.context = {
            mode,
            rules,
            prePlanMode,
            strippedDangerousRules,
            additionalWorkingDirectories: [],
            isBypassPermissionsModeAvailable: false,
            isAutoModeAvailable: true,
        }
    }

    /**
     * 保存到 SQLite
     *
     * 优化：单条规则增删操作使用增量写入（INSERT OR REPLACE / DELETE），
     * 避免全量 DELETE + re-INSERT 的性能开销。模式切换和批量设置仍使用全量覆写。
     */
    private async saveToDatabase(update?: PermissionUpdate): Promise<void> {
        // 保存规则到 PermissionRepository
        try {
            if (update?.type === 'addRule') {
                // 增量写入：只更新单条规则（INSERT OR REPLACE）
                this.permissionRepo.addRule(update.rule)
            } else if (update?.type === 'removeRule') {
                // 增量删除：只删除单条规则
                this.permissionRepo.removeRule(update.tool)
            } else {
                // setMode / setRules 等全量操作，使用全量覆写
                this.permissionRepo.saveRules(this.context.rules)
            }
        } catch (err) {
            logger.error('[PermissionRulesManager] saveToDatabase: failed to save rules', {error: err})
        }

        // 保存配置到 system_settings
        try {
            systemSettingsRepo.set('permission_mode', this.context.mode)

            if (this.context.prePlanMode) {
                systemSettingsRepo.set('permission_pre_plan_mode', this.context.prePlanMode)
            } else {
                systemSettingsRepo.delete('permission_pre_plan_mode')
            }

            if (this.context.strippedDangerousRules && this.context.strippedDangerousRules.length > 0) {
                systemSettingsRepo.set('permission_stripped_dangerous_rules', JSON.stringify(this.context.strippedDangerousRules))
            } else {
                systemSettingsRepo.delete('permission_stripped_dangerous_rules')
            }
        } catch (err) {
            logger.error('[PermissionRulesManager] saveToDatabase: failed to save config', {error: err})
        }
    }

    /**
     * 重新加载（用于与其他进程同步）
     */
    async reload(): Promise<void> {
        await this.loadFromDatabase()
    }

    /**
     * 获取危险权限信息（用于UI展示）
     */
    async getDangerousPermissions(): Promise<DangerousPermissionInfo[]> {
        await this.ensureInit()
        return findDangerousPermissions(this.context.rules)
    }
}

/**
 * 全局单例
 */
export const permissionRulesManager = new PermissionRulesManager()

