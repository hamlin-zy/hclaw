/**
 * Skills 指导内容构建器
 *
 * 从 SkillDefinition 构建技能指导文本（用于注入到 LLM 上下文）。
 * 提取自 skillTool.ts，供 skillTool 和 IPC handler 共享使用。
 */

import type {SkillDefinition} from './types'

/** 构建技能指导（含扩展资源路径） */
export function buildGuidance(skill: SkillDefinition): string {
    const parts = [
        `# ${skill.name}`,
        '',
        `**${skill.description || ''}**`,
        '',
        '## 技能指导',
        skill.content || '',
    ]

    if (skill.extensions) {
        const extLines = [
            skill.extensions.scripts?.length && (
                '## 可用脚本\n' +
                skill.extensions.scripts.map(s => `- \`${skill.skillDir}/scripts/${s.name}\``).join('\n')
            ),
            skill.extensions.references?.length && (
                '## 参考文档\n' +
                skill.extensions.references.map(r => `- \`${skill.skillDir}/references/${r.name}.md\``).join('\n')
            ),
        ].filter(Boolean) as string[]

        if (extLines.length) {
            parts.push('\n## 扩展资源', ...extLines, '\n💡 使用 file_read 工具读取上述参考文档。')
        }
    }

    return parts.join('\n')
}

/** 构建技能指导预览（前 500 字 + 资源计数） */
export function buildPreview(skill: SkillDefinition): string {
    const parts = [
        `# ${skill.name}`,
        '',
        `${skill.description || ''}`,
        '',
        `技能指导：\n${(skill.content || '').slice(0, 500)}${(skill.content || '').length > 500 ? '...' : ''}`,
    ]

    if (skill.extensions) {
        const extCount =
            (skill.extensions.scripts?.length || 0) +
            (skill.extensions.references?.length || 0)
        if (extCount > 0) {
            parts.push(`\n可用资源：${extCount} 个文件`)
        }
    }

    return parts.join('\n')
}

/** 构建技能命令模板（含 skillDir 路径，供命令模式使用） */
export function buildSkillCommandTemplate(skill: SkillDefinition): string {
    const guidance = buildGuidance(skill)
    return (
        `# 技能模式: ${skill.name}\n\n` +
        `你正在使用技能 "${skill.name}"。\n` +
        `技能安装路径: \`${skill.skillDir || ''}\`\n` +
        `请按照以下指导执行此技能：\n\n` +
        guidance
    )
}
