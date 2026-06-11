/**
 * SkillMatcher — 技能匹配器
 *
 * 根据用户消息和意图分析结果，匹配最相关的技能。
 * 采用多维度评分策略：名称匹配 > 描述匹配 > 内容匹配 > 工具重叠。
 */

import type {SkillDefinition} from './types'
import type {IntentAnalysisResult} from '@shared/types'

export interface SkillMatch {
    skill: SkillDefinition
    score: number
    matchedKeywords: string[]
    reason: string
}

/** 提取关键词 */
const extractKeywords = (text: string): string[] =>
    text.replace(/[^\w\s\u4e00-\u9fff]/g, ' ').split(/\s+/).filter(w => w.length > 0)

/** 关键词匹配计数 */
const countKeywordMatches = (text: string, keywords: string[], minLen = 2): number =>
    keywords.filter(w => w.length >= minLen && text.includes(w)).length

export class SkillMatcher {
    match(
        userMessage: string,
        skills: SkillDefinition[],
        intentResult?: IntentAnalysisResult,
        topK: number = 3,
    ): SkillMatch[] {
        const enabledSkills = skills.filter(s => s.enabled)
        const messageLower = userMessage.toLowerCase()
        const messageWords = extractKeywords(messageLower)

        const matches = enabledSkills
            .map(skill => this.scoreSkill(skill, messageLower, messageWords, intentResult))
            .filter(m => m.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, topK)

        return matches
    }

    private scoreSkill(
        skill: SkillDefinition,
        messageLower: string,
        messageWords: string[],
        intentResult?: IntentAnalysisResult,
    ): SkillMatch {
        const matchedKeywords: string[] = []
        const reasons: string[] = []
        let score = 0

        const nameLower = skill.name.toLowerCase()
        const nameWords = extractKeywords(nameLower)
        const descLower = (skill.userDescription || skill.description || '').toLowerCase()
        const contentLower = (skill.content || '').toLowerCase()

        // 1. 名称完全匹配（最高权重）
        if (messageLower.includes(nameLower)) {
            score += 10
            matchedKeywords.push(skill.name)
            reasons.push(`名称匹配: "${skill.name}"`)
        }

        // 2. 名称分词匹配
        for (const word of nameWords) {
            if (word.length > 1 && messageWords.includes(word) && !matchedKeywords.includes(word)) {
                score += 3
                matchedKeywords.push(word)
            }
        }

        // 3. 描述关键词匹配
        const descMatches = countKeywordMatches(descLower, messageWords)
        if (descMatches > 0) {
            score += descMatches * 1.5
            reasons.push(`描述匹配: ${descMatches} 个关键词`)
            matchedKeywords.push(...messageWords.filter(w => descLower.includes(w) && !matchedKeywords.includes(w)))
        }

        // 4. 技能正文匹配（低权重）
        const contentMatches = countKeywordMatches(contentLower, messageWords, 3)
        if (contentMatches > 2) {
            score += Math.min(contentMatches * 0.3, 2)
            reasons.push(`内容匹配: ${contentMatches} 个关键词`)
        }

        // 5. 意图分析增强
        if (intentResult && score > 0) {
            if (intentResult.complexity === 'complex' && score > 5) score *= 1.2
            if (intentResult.needsPlanning && score > 3) score *= 1.1
        }

        return {skill, score: Math.round(score * 10) / 10, matchedKeywords, reason: reasons.join('; ') || '弱相关匹配'}
    }
}

export const skillMatcher = new SkillMatcher()
