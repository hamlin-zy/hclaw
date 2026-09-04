import type {PhraseItem} from '@shared/types/phrase'

/** 按 content 不区分大小写过滤短语（query 为空时原样返回） */
export function filterPhrases(items: PhraseItem[], query: string): PhraseItem[] {
    const q = query.trim().toLowerCase()
    if (!q) return items
    return items.filter(p => p.content.toLowerCase().includes(q))
}
