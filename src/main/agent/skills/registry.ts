/**
 * Skills Registry - Manages skill registration and lookup
 */

import type {SkillDefinition} from './types'
import type {ICapabilityRegistry} from '../../common/registry'
import {container, DI_TOKENS} from '../common/container'

export class SkillRegistryImpl implements ICapabilityRegistry<SkillDefinition> {
    private skills = new Map<string, SkillDefinition>()
    private conditionalSkills = new Map<string, SkillDefinition>()

    register(skill: SkillDefinition): void {
        this.skills.set(skill.id, skill)
        if (skill.paths?.length) this.conditionalSkills.set(skill.id, skill)
    }

    unregister(skillId: string): void {
        const skill = this.skills.get(skillId)
        if (skill?.paths?.length) this.conditionalSkills.delete(skillId)
        this.skills.delete(skillId)
    }

    unregisterByPlugin(pluginName: string): number {
        const toRemove = [...this.skills].filter(([, s]) => s.pluginName === pluginName).map(([id]) => id)
        toRemove.forEach(id => this.unregister(id))
        return toRemove.length
    }

    get(skillId: string): SkillDefinition | undefined {
        return this.skills.get(skillId)
    }

    getAll(): SkillDefinition[] {
        return [...this.skills.values()]
    }

    getConditionalSkills(): SkillDefinition[] {
        return [...this.conditionalSkills.values()]
    }

    findConditionalSkills(filePath: string): SkillDefinition[] {
        return this.getConditionalSkills().filter(skill =>
            skill.paths?.some(pattern => {
                const regex = new RegExp(pattern.replace(/[*?]/g, m => (m === '*' ? '.*' : '.')))
                return regex.test(filePath)
            }),
        )
    }

    find(skillNameOrId: string): SkillDefinition | undefined {
        const skills = this.getAll()
        const normalize = (s: string) => s.toLowerCase().replace(/[-_]/g, '')
        const norm = normalize(skillNameOrId)
        return (
            skills.find(s => s.id === skillNameOrId) ||
            skills.find(s => s.name === skillNameOrId) ||
            skills.find(s => normalize(s.name) === norm || normalize(s.id) === norm)
        )
    }

    getEnabled(): SkillDefinition[] {
        return this.getAll().filter(s => s.enabled && s.pluginEnabled !== false)
    }

    syncPluginStatus(pluginName: string, enabled: boolean): void {
        for (const skill of this.skills.values()) {
            if (skill.pluginName === pluginName) {
                skill.enabled = enabled
                skill.pluginEnabled = enabled
            }
        }
    }

    clear(): void {
        this.skills.clear()
        this.conditionalSkills.clear()
    }

    getEnabledSkillContents(): string[] {
        return this.getEnabled().map(s => `### ${s.name}\n\n${s.content}`)
    }
}

export const skillRegistry = new SkillRegistryImpl()

container.register(DI_TOKENS.SkillRegistry, skillRegistry)

export const getSkillRegistry = (): SkillRegistryImpl => container.get<SkillRegistryImpl>(DI_TOKENS.SkillRegistry)
