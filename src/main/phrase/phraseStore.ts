import * as fs from 'fs'
import * as path from 'path'
import {randomUUID} from 'crypto'
import type {PhraseItem} from '@shared/types/phrase'
import {getHclawDir} from '../config'
import {logger} from '../agent/logger'

const PHRASE_FILE = () => path.join(getHclawDir(), 'data', 'phrases', 'phrases.json')

class PhraseStore {
    private readAll(): PhraseItem[] {
        const file = PHRASE_FILE()
        if (!fs.existsSync(file)) return []
        try {
            return JSON.parse(fs.readFileSync(file, 'utf8')) as PhraseItem[]
        } catch {
            const backup = `${file}.corrupt-${Date.now()}`
            try {
                fs.renameSync(file, backup)
            } catch (err) {
                logger.error('[PhraseStore] corrupt backup failed', {file, error: String(err)})
            }
            logger.warn('[PhraseStore] phrases.json corrupted, backed up', {file, backup})
            return []
        }
    }

    private writeAll(items: PhraseItem[]): void {
        const file = PHRASE_FILE()
        fs.mkdirSync(path.dirname(file), {recursive: true})
        const tmp = `${file}.tmp-${randomUUID()}`
        fs.writeFileSync(tmp, JSON.stringify(items, null, 2), 'utf8')
        fs.renameSync(tmp, file)
    }

    list(): PhraseItem[] {
        return this.readAll()
    }

    create(input: {content: string}): PhraseItem {
        const content = input.content?.trim() ?? ''
        if (!content) throw new Error('PHRASE_EMPTY')
        const now = Date.now()
        const item: PhraseItem = {id: `phrase-${randomUUID()}`, content, createdAt: now, updatedAt: now, lastUsedAt: now}
        const items = this.readAll()
        items.unshift(item)
        this.writeAll(items)
        return item
    }

    update(id: string, patch: {content: string}): PhraseItem {
        const content = patch.content?.trim() ?? ''
        if (!content) throw new Error('PHRASE_EMPTY')
        const items = this.readAll()
        const idx = items.findIndex(p => p.id === id)
        if (idx === -1) throw new Error('PHRASE_NOT_FOUND')
        const updated: PhraseItem = {...items[idx], content, updatedAt: Date.now()}
        items[idx] = updated
        this.writeAll(items)
        return updated
    }

    touch(id: string): PhraseItem {
        const items = this.readAll()
        const idx = items.findIndex(p => p.id === id)
        if (idx === -1) throw new Error('PHRASE_NOT_FOUND')
        const updated: PhraseItem = {...items[idx], lastUsedAt: Date.now()}
        items[idx] = updated
        this.writeAll(items)
        return updated
    }

    remove(id: string): void {
        this.writeAll(this.readAll().filter(p => p.id !== id))
    }
}

export const phraseStore = new PhraseStore()
