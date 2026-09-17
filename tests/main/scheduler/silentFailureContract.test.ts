/**
 * 静默失败清理与静态契约（工单 core-08）
 *
 * 直接读源文件断言跨文件的约束，先例见 tests/main/scheduler/scheduleChangeBroadcast.test.ts
 * 与 tests/main/capability/capabilityChangedBroadcast.test.ts 的 readSrc 手法。
 *
 * 三条规则（对应票据四问）：
 * 1. **无空 catch**：`catch {}` 在定时任务目录下不再出现（块内连注释都没有 → 违规）。
 * 2. **降级要么上报、要么显式静默**：块内只有注释（没有任何语句）时，注释必须写明
 *    为什么可以静默 —— 用固定标记 `静默：` / `SILENT:` 起始，防止「// 静默失败」
 *    这种不解释理由的占位注释回潮。带语句的 catch（例如 `return fail(err)`、
 *    `logger.error(...)`）由语句自身承担上报或降级语义，不在此规则内。
 * 3. **单文件单一日志出口**：同一文件不得同时出现 `logger.` / `createLogger(` 与
 *    `console.*`。index.ts 曾两者并存（结构化 logger + 裸 console.error），现已收敛。
 *
 * 另断言 index.ts 文件头声明的 IPC 控制方法在导出的单例上真实存在（票面「声明了但不存在」）。
 */
import {describe, expect, it, vi} from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

// 隔离：config 指向临时目录，避免导入 index.ts 时触碰真实 ~/.hclaw
vi.mock('@/main/config', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- vi.mock 工厂被提升
    const os = require('os')
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- 同上
    const path = require('path')
    const testDir = path.join(os.tmpdir(), 'hclaw-test-silent-contract-' + Date.now())
    return {
        getHclawDir: () => testDir,
        isSafePath: (p: string) => p.startsWith(testDir),
        HCLAW_DIR: testDir,
        getHclawDataDir: () => path.join(testDir, 'data'),
    }
})
vi.mock('@/main/hclawPaths', async () => await import('@/main/config'))  // 路径能力已下沉到叶子 hclawPaths：让叶子跟随本文件对 config 的桩，避免绕过 mock 落到真实 ~/.hclaw

vi.mock('@/main/agent/logger', () => ({
    createLogger: () => ({debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}),
    logger: {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()},
}))

import {schedulerManager} from '@/main/scheduler'

const SCHEDULER_DIR = 'src/main/scheduler'

const readSrc = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf-8')

/** 定时任务目录下的全部 ts 源文件（相对仓库根的 POSIX 路径） */
function schedulerFiles(): string[] {
    return fs.readdirSync(path.join(process.cwd(), SCHEDULER_DIR), {recursive: true})
        .map(f => String(f).replace(/\\/g, '/'))
        .filter(f => f.endsWith('.ts'))
        .map(f => `${SCHEDULER_DIR}/${f}`)
        .sort()
}

/**
 * 抽出源文件里每个 catch 块的块体（不含外层大括号）与起始行号。
 * 用大括号配平扫描；本目录的 catch 块内模板字符串 `${...}` 均自配平，不影响定位。
 */
function catchBlocks(src: string): Array<{body: string; line: number}> {
    const blocks: Array<{body: string; line: number}> = []
    const re = /\bcatch\b\s*(?:\([^)]*\))?\s*\{/g
    let m: RegExpExecArray | null
    while ((m = re.exec(src)) !== null) {
        const open = m.index + m[0].length - 1
        let depth = 0
        let i = open
        for (; i < src.length; i++) {
            if (src[i] === '{') depth++
            else if (src[i] === '}') {
                depth--
                if (depth === 0) break
            }
        }
        blocks.push({body: src.slice(open + 1, i), line: src.slice(0, open).split('\n').length})
    }
    return blocks
}

/** 去掉注释后的残余（只剩空白 ⇒ 块体内没有任何语句） */
const stripComments = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

/**
 * 显式静默标记：注释必须以它起始，后接「为什么可以静默」。
 *
 * 理由不能是空串——`// 静默：` 这类占位注释不算说明，
 * 故标记后必须在**同一行内**接至少 2 个文字/数字字符（跨行续写的注释由后一行自证理由，
 * 不借给标记行充数；注释收尾的撇号字符一并排除，避免把块注释的结束符号算成理由）。
 */
const SILENCE_MARKER = /静默[:：][^\S\n*/]*[\p{L}\p{N}]{2,}|SILENT:[^\S\n*/]*[\p{L}\p{N}]{2,}/u

describe('core-08 静态契约 — 定时任务目录不再有静默失败', () => {
    it('扫描面非空：确实读到了定时任务目录的源文件与 catch 块', () => {
        const files = schedulerFiles()
        expect(files.length).toBeGreaterThanOrEqual(8)
        expect(files).toContain('src/main/scheduler/index.ts')
        const total = files.reduce((n, f) => n + catchBlocks(readSrc(f)).length, 0)
        expect(total).toBeGreaterThanOrEqual(10)
    })

    it('不存在空 catch（块体内既无语句也无注释）', () => {
        const offenders: string[] = []
        for (const file of schedulerFiles()) {
            for (const {body, line} of catchBlocks(readSrc(file))) {
                if (body.trim() === '') offenders.push(`${file}:${line}`)
            }
        }
        expect(offenders).toEqual([])
    })

    it('块体内只有注释的 catch 必须写明为什么可以静默（标记 `静默：`）', () => {
        const offenders: string[] = []
        for (const file of schedulerFiles()) {
            for (const {body, line} of catchBlocks(readSrc(file))) {
                if (body.trim() === '') continue // 空 catch 由上一条断言负责
                if (stripComments(body).trim() !== '') continue // 有语句 ⇒ 降级语义由语句承担
                if (!SILENCE_MARKER.test(body)) offenders.push(`${file}:${line}`)
            }
        }
        expect(offenders).toEqual([])
    })

    it('单个文件内不并存两套日志机制（logger 与 console 互斥）', () => {
        const offenders: string[] = []
        for (const file of schedulerFiles()) {
            const src = readSrc(file)
            const usesLogger = /createLogger\(|\blogger\./.test(src)
            const usesConsole = /\bconsole\.(log|info|warn|error|debug)\b/.test(src)
            if (usesLogger && usesConsole) offenders.push(file)
        }
        expect(offenders).toEqual([])
    })

    it('index.ts 收敛到统一 logger，不再有裸 console 调用', () => {
        const src = readSrc('src/main/scheduler/index.ts')
        expect(src).toMatch(/createLogger\('scheduler'\)/)
        expect(src).not.toMatch(/\bconsole\.(log|info|warn|error|debug)\b/)
    })
})

describe('core-08 静态契约 — 文件头声明的方法真实存在', () => {
    /** 取文件头注释（首个块注释结束符之前）中以 `方法名()` 形式列出的公开方法 */
    function declaredMethods(src: string): string[] {
        const header = src.slice(0, src.indexOf('*/'))
        const anchor = header.indexOf('IPC 控制方法')
        const scope = anchor >= 0 ? header.slice(anchor) : ''
        return [...scope.matchAll(/([A-Za-z_$][\w$]*)\(\)/g)].map(m => m[1])
    }

    it('index.ts 文件头列出的方法清单被解析出来（清单非空才谈得上断言）', () => {
        expect(declaredMethods(readSrc('src/main/scheduler/index.ts'))).toEqual([
            'pause', 'resume', 'stop', 'runNow',
            'upsertWorkerSchedule', 'deleteWorkerSchedule',
        ])
    })

    it('清单中的每个方法都真实存在于导出的 schedulerManager 上且可调用', () => {
        const methods = declaredMethods(readSrc('src/main/scheduler/index.ts'))
        const instance = schedulerManager as unknown as Record<string, unknown>
        for (const name of methods) {
            expect(typeof instance[name], `文件头声明的 ${name}() 不存在`).toBe('function')
        }
    })

    it('只有 index.ts 带有这类方法清单，新增清单即纳入本契约', () => {
        const withList = schedulerFiles()
            .filter(f => /^\s*\*\s*-\s*[A-Za-z_$][\w$]*\(\)/m.test(readSrc(f)))
        expect(withList).toEqual(['src/main/scheduler/index.ts'])
    })
})
