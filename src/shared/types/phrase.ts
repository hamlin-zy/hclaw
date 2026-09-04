export interface PhraseItem {
    id: string          // phrase-<uuid>
    content: string     // 短语正文，纯文本，支持多行
    createdAt: number
    updatedAt: number   // 仅在 content 被 create/update 时更新
    lastUsedAt: number  // 初始 = createdAt；每次粘贴经 touch 更新（MRU 依据）
}
