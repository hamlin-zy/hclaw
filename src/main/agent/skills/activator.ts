/**
 * 条件技能激活器
 *
 * 基于文件路径模式（使用 .gitignore 风格的 glob 规则）激活条件技能。
 * 当用户编辑的文件匹配技能的 paths 规则时，自动激活该技能。
 *
 * 使用场景：
 * - 某些技能只在特定类型的项目中生效（如 TypeScript 技能）
 * - 某些技能只在特定目录下生效（如 docs 技能）
 * - 某些技能只在特定文件类型下生效（如 frontend 技能）
 */

import ignore from 'ignore'
import * as path from 'path'
import type { Skill } from '@shared/types'

class SkillActivator {
  /** 待激活的条件技能（key: skillId, value: skill） */
  private pendingSkills = new Map<string, Skill>()
  /** 已激活的技能 ID 集合 */
  private activatedSkills = new Set<string>()
  /** 已激活技能的快照（用于 getActivatedSkills） */
  private activatedSkillsSnapshot = new Map<string, Skill>()

  /**
   * 设置条件技能列表
   *
   * @param skills 技能列表（应该包含 paths 字段）
   */
  setConditionalSkills(skills: Skill[]): void {
    this.pendingSkills.clear()
    this.activatedSkills.clear()
    this.activatedSkillsSnapshot.clear()

    for (const skill of skills) {
      // 只处理有 paths 配置的技能
      if (skill.paths && skill.paths.length > 0) {
        this.pendingSkills.set(skill.id, skill)
      }
    }
  }

  /**
   * 基于文件路径激活技能
   *
   * @param filePaths 用户正在编辑的文件路径列表
   * @param cwd 当前工作目录（用于计算相对路径）
   * @returns 新激活的技能 ID 列表
   *
   * 工作流程：
   * 1. 遍历所有待激活的条件技能
   * 2. 对每个技能，使用 ignore 库创建路径匹配器
   * 3. 检查文件路径是否匹配
   * 4. 如果匹配，从待激活列表移除，添加到已激活列表
   * 5. 返回新激活的技能 ID
   */
  activateForPaths(filePaths: string[], cwd: string): string[] {
    const activated: string[] = []

    for (const [skillId, skill] of this.pendingSkills) {
      if (!skill.paths || skill.paths.length === 0) continue

      // 创建 ignore 实例用于路径匹配
      const ig = ignore().add(skill.paths)

      for (const filePath of filePaths) {
        // 计算相对路径
        let relativePath: string
        if (path.isAbsolute(filePath)) {
          try {
            relativePath = path.relative(cwd, filePath)
          } catch {
            // 跨驱动盘路径无法计算相对路径，跳过
            continue
          }
        } else {
          relativePath = filePath
        }

        // 边界情况检查
        // 1. 相对路径为空（说明就是 cwd 本身）
        // 2. 相对路径以 .. 开头（说明在 cwd 之外）
        // 3. 相对路径仍是绝对路径（Windows 特殊情况）
        if (
          !relativePath ||
          relativePath.startsWith('..') ||
          path.isAbsolute(relativePath)
        ) {
          continue
        }

        // 检查是否匹配（ignore.ignores 返回 true 表示应该被忽略）
        if (ig.ignores(relativePath)) {
          this.activatedSkills.add(skillId)
          this.activatedSkillsSnapshot.set(skillId, skill)
          activated.push(skillId)
          // 从待激活列表中移除（避免重复激活）
          this.pendingSkills.delete(skillId)
          break
        }
      }
    }

    return activated
  }

  /**
   * 获取已激活的技能列表
   *
   * @returns 已激活的技能对象数组
   */
  getActivatedSkills(): Skill[] {
    return Array.from(this.activatedSkillsSnapshot.values())
  }

  /**
   * 检查指定技能是否已激活
   *
   * @param skillId 技能 ID
   * @returns 是否已激活
   */
  isActivated(skillId: string): boolean {
    return this.activatedSkills.has(skillId)
  }

  /**
   * 重置激活器状态
   *
   * 清空所有待激活和已激活的技能。
   * 主要用于测试隔离。
   */
  reset(): void {
    this.pendingSkills.clear()
    this.activatedSkills.clear()
    this.activatedSkillsSnapshot.clear()
  }

  /**
   * 获取待激活的技能数量
   */
  getPendingCount(): number {
    return this.pendingSkills.size
  }

  /**
   * 获取已激活的技能数量
   */
  getActivatedCount(): number {
    return this.activatedSkills.size
  }
}

/** 单例实例 */
export const skillActivator = new SkillActivator()
