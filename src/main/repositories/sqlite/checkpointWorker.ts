import {parentPort, workerData} from 'node:worker_threads'
import {DatabaseSync, enhance} from '@photostructure/sqlite'
import * as fs from 'fs'

export const CHECK_INTERVAL_MS = 10_000
export const WAL_THRESHOLD_BYTES = 64 * 1024 * 1024

function walFileSize(dbPath: string): number {
    try {
        return fs.statSync(dbPath + '-wal').size
    } catch {
        return 0
    }
}

/** 可单测的 checkpoint 控制器：检查 WAL 超阈值则 TRUNCATE 合并（在调用方线程执行） */
export function createCheckpointController(dbPath: string): {
    check(): { checkpointed: boolean; walBytes: number; durationMs: number }
} {
    const db = enhance(new DatabaseSync(dbPath))
    db.pragma('journal_mode = WAL')
    db.pragma('busy_timeout = 5000')
    return {
        check() {
            const walBytes = walFileSize(dbPath)
            if (walBytes < WAL_THRESHOLD_BYTES) return {checkpointed: false, walBytes, durationMs: 0}
            const start = Date.now()
            db.pragma('wal_checkpoint(TRUNCATE)')
            return {checkpointed: true, walBytes, durationMs: Date.now() - start}
        },
    }
}

// ── Worker 入口（仅在工作线程内执行；node 环境直接 import 时 workerData 为 undefined） ──
if (parentPort && typeof workerData === 'object' && workerData && 'dbPath' in (workerData as object)) {
    const {dbPath} = workerData as {dbPath: string}
    const controller = createCheckpointController(dbPath)
    const loop = async (): Promise<void> => {
        for (;;) {
            await new Promise((r) => setTimeout(r, CHECK_INTERVAL_MS))
            try {
                const result = controller.check()
                if (result.checkpointed) {
                    parentPort.postMessage({type: 'checkpointed', ...result})
                }
            } catch (err) {
                parentPort.postMessage({
                    type: 'error',
                    error: err instanceof Error ? err.message : String(err),
                })
            }
        }
    }
    void loop()
}
