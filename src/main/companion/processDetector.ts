import {execFile} from 'child_process'
import {promisify} from 'util'
import {logger} from '../agent/logger'

const execFileAsync = promisify(execFile)

/** 短缓存 TTL：同周期内多个 isProcessRunning 共享一次 tasklist 输出（spec §3） */
const CACHE_TTL = 500
/** tasklist 单次调用超时 */
const TASKLIST_TIMEOUT_MS = 5000

let cachedOutput: string | null = null
let cachedAt = 0

/** 解析 tasklist /FO CSV /NH 输出：每行第一列去引号，统一小写 */
export function parseTaskList(stdout: string): string[] {
    const names: string[] = []
    for (const line of stdout.split('\n')) {
        const match = line.match(/^"([^"]+)"/)
        if (match) names.push(match[1].toLowerCase())
    }
    return names
}

async function getTaskList(): Promise<string> {
    const now = Date.now()
    if (cachedOutput !== null && now - cachedAt < CACHE_TTL) return cachedOutput
    try {
        const {stdout} = await execFileAsync('tasklist', ['/FO', 'CSV', '/NH'], {timeout: TASKLIST_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024})
        cachedOutput = stdout
    } catch (err) {
        // tasklist 失败/超时按空表处理（本次调用视为未运行），并使缓存失效避免污染下一周期
        logger.warn('companion-tasklist-failed', {error: String(err)})
        cachedOutput = ''
    }
    cachedAt = now
    return cachedOutput
}

export async function isProcessRunning(processName: string): Promise<boolean> {
    // 非 Windows 未支持进程检测（tasklist 仅 win32），等待语义按「已就绪」退化（与 tasklist 失败缓存行为一致）
    if (process.platform !== 'win32') return false
    const stdout = await getTaskList()
    if (!stdout) return false
    const target = processName.toLowerCase()
    return parseTaskList(stdout).includes(target)
}

/** 仅测试用：清空缓存 */
export function resetProcessCache(): void {
    cachedOutput = null
    cachedAt = 0
}
