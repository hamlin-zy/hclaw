/**
 * 技能脚本执行的进程树收尾（内存泄漏 B 批 Task 1 / S1b）—— 真进程集成测试
 *
 * 起一棵真进程树：node（根，即 executeScript 直接拉起的解释器）→ node 子脚本 → node 孙进程，
 * 孙进程每 50ms 往心跳文件追加一行。脚本超时后要求**整棵树**被清掉（心跳停止）。
 * 这正是不用 proc.kill() 的理由：内建 kill 只结束根进程，脚本拉起的子孙会以孤儿身份
 * 活下来继续占内存/句柄——也就是本批要堵的那一面。
 *
 * 仅 Windows 有树杀语义（其余平台退化为只杀根进程），故非 win32 直接 skip。
 */
import {describe, expect, it} from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {executeScript} from '@/main/agent/skills/scriptExecutor'
import type {ScriptFile} from '@/main/agent/skills/types'

const isWin = process.platform === 'win32'
const POLL_MS = 100
const WAIT_MS = 10_000

async function waitFor(cond: () => boolean, label: string, timeoutMs = WAIT_MS): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        if (cond()) return
        await new Promise((r) => setTimeout(r, POLL_MS))
    }
    throw new Error(`等待「${label}」超时（${timeoutMs}ms）`)
}

function isAlive(pid: number): boolean {
    try {
        process.kill(pid, 0)
        return true
    } catch {
        return false
    }
}

function killIfAlive(pid: number | undefined): void {
    if (!pid) return
    try {
        process.kill(pid)
    } catch {
        // 已退出
    }
}

/** 孙进程：持续写心跳，进程活着文件就在长 */
const GRANDCHILD_JS = `const fs = require('fs')
setInterval(() => fs.appendFileSync(process.argv[2], Date.now() + '\\n'), 50)
`

/** 根脚本（被 executeScript 用 node 拉起）：拉起孙进程、落盘两个 pid、保持存活 */
const ROOT_JS = `const {spawn} = require('child_process')
const fs = require('fs')
const args = JSON.parse(process.argv[2])
const child = spawn(process.execPath, [args.grandchildScript, args.beatFile], {windowsHide: true, stdio: 'ignore'})
fs.writeFileSync(args.pidFile, JSON.stringify({child: process.pid, grandchild: child.pid}))
setInterval(() => {}, 1000)
`

describe.skipIf(!isWin)('scriptExecutor — 脚本超时后的进程树清理（真进程）', () => {
    it('超时树杀后子孙进程不再存活、心跳停止', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hclaw-script-tree-'))
        const rootScript = path.join(dir, 'root.cjs')
        const grandchildScript = path.join(dir, 'grandchild.cjs')
        const beatFile = path.join(dir, 'beat.txt')
        const pidFile = path.join(dir, 'pids.json')
        fs.writeFileSync(rootScript, ROOT_JS, 'utf-8')
        fs.writeFileSync(grandchildScript, GRANDCHILD_JS, 'utf-8')

        const script: ScriptFile = {
            name: 'root.cjs',
            path: 'root.cjs',
            fullPath: rootScript,
            language: 'node',
            executable: true,
        }

        let tree: {child: number; grandchild: number} | null = null
        try {
            const pending = executeScript(script, {grandchildScript, beatFile, pidFile}, {
                timeout: 1500,
                cwd: dir,
            })

            // 前置证据：整棵树真的起来了（孙进程已在写心跳），否则后面的断言没有意义
            await waitFor(() => fs.existsSync(pidFile), '子/孙进程 pid 落盘')
            tree = JSON.parse(fs.readFileSync(pidFile, 'utf-8')) as {child: number; grandchild: number}
            await waitFor(
                () => fs.existsSync(beatFile) && fs.statSync(beatFile).size > 0,
                '孙进程心跳已开始',
            )

            const result = await pending

            // 超时语义不变：失败 + 固定的超时文案
            expect(result.success).toBe(false)
            expect(result.error).toBe('Script timed out')

            // 整棵树都要消失（只杀根进程的话，孙进程会继续写心跳）
            await waitFor(
                () => !isAlive(tree!.child) && !isAlive(tree!.grandchild),
                '超时后子进程与孙进程全部退出',
            )
            const sizeAfterTimeout = fs.statSync(beatFile).size
            await new Promise((r) => setTimeout(r, 500))
            expect(fs.statSync(beatFile).size).toBe(sizeAfterTimeout)
        } finally {
            killIfAlive(tree?.child)
            killIfAlive(tree?.grandchild)
            try {
                fs.rmSync(dir, {recursive: true, force: true})
            } catch {
                // 临时目录清理失败不影响结论
            }
        }
    }, 30_000)
})
