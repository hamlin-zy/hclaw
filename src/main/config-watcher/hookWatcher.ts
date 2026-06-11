import fs from 'fs'
import {getHookConfigPath, readHookConfig} from '../config/hookConfig'
import {logger} from '../agent/logger'

const DEBOUNCE_MS = 500

export class HookWatcher {
    private watcher: fs.FSWatcher | null = null
    private debounceTimer: ReturnType<typeof setTimeout> | null = null

    start(): void {
        const configPath = getHookConfigPath()
        if (!fs.existsSync(configPath)) {
            try {
                fs.writeFileSync(configPath, JSON.stringify({hooks: {}}, null, 2), 'utf-8')
            } catch {
                logger.warn('[HookWatcher] could not create hooks.json')
                return
            }
        }

        try {
            this.watcher = fs.watch(configPath, {encoding: 'utf-8'}, (eventType) => {
                if (eventType !== 'change') return
                if (this.debounceTimer) clearTimeout(this.debounceTimer)
                this.debounceTimer = setTimeout(() => this.handleChange(), DEBOUNCE_MS)
            })
            logger.info('[HookWatcher] started watching', {path: configPath})
        } catch (err: any) {
            logger.error('[HookWatcher] start failed:', {error: err.message})
        }
    }

    stop(): void {
        if (this.watcher) {
            this.watcher.close()
            this.watcher = null
        }
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer)
            this.debounceTimer = null
        }
        logger.info('[HookWatcher] stopped')
    }

    private handleChange(): void {
        try {
            const hooks = readHookConfig()
            logger.info('[HookWatcher] hooks.json changed', {count: hooks.length})
        } catch (err: any) {
            logger.error('[HookWatcher] handleChange failed:', {error: err.message})
        }
    }
}
