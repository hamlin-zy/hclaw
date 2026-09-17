/**
 * 进程树终止工具单测（内存泄漏 B 批 Task 1）
 *
 * 为什么必须树杀：Node 内建 kill 只结束根进程。Windows 上根进程一退出，
 * `taskkill /F /T` 就再也遍历不到它的子孙（树已经断开），中继/解释器进程拉起的
 * 子进程因此成为孤儿——继续持有句柄、占着内存，正是本批要堵的那一面。
 *
 * 本文件真起一棵三层进程树（cmd → node → node），树杀后断言三层全灭，
 * 并以「孙进程心跳文件停止增长」作为第二重证据（避免只靠 pid 探测的假阴性）。
 * 仅 Windows 有树杀语义，其他平台 skip。
 */
import {describe, expect, it} from 'vitest'
import {spawn} from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {killProcessTree} from '@/main/common/killProcessTree'

const isWin = process.platform === 'win32'
const POLL_MS = 100
const WAIT_MS = 10_000

/** 轮询等待条件成立（超时即失败，报出是哪一步没等到） */
async function waitFor(cond: () => boolean, label: string, timeoutMs = WAIT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (cond()) return
    await new Promise((r) => setTimeout(r, POLL_MS))
  }
  throw new Error(`等待「${label}」超时（${timeoutMs}ms）`)
}

/** 进程是否仍存活（口径与 src/main/agent/mcp/transport/processUtils 一致） */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** 尽力清理：用例失败时也不能把子进程留在机器上 */
function killIfAlive(pid: number | undefined): void {
  if (!pid) return
  try {
    process.kill(pid)
  } catch {
    // 已退出
  }
}

/** 孙进程：每 50ms 往心跳文件追加一行，进程活着文件就在长 */
const GRANDCHILD_JS = `const fs = require('fs')
setInterval(() => fs.appendFileSync(process.argv[2], Date.now() + '\\n'), 50)
`

/** 子进程：拉起孙进程，把两个 pid 落盘，自己保持存活 */
const CHILD_JS = `const {spawn} = require('child_process')
const fs = require('fs')
const grandchild = spawn(process.execPath, [process.argv[2], process.argv[3]], {windowsHide: true, stdio: 'ignore'})
fs.writeFileSync(process.argv[4], JSON.stringify({child: process.pid, grandchild: grandchild.pid}))
setInterval(() => {}, 1000)
`

/** 心跳脚本：先把自身 pid 落盘，再持续写心跳（对照用例里作为「中继拉起的子进程」） */
const HEARTBEAT_JS = `const fs = require('fs')
fs.writeFileSync(process.argv[3], String(process.pid))
setInterval(() => fs.appendFileSync(process.argv[2], Date.now() + '\\n'), 50)
`

type TreePids = {child: number; grandchild: number}

/** 三件夹具脚本的落盘位置（临时目录内） */
function makeFixtures(dir: string) {
  const grandchildScript = path.join(dir, 'grandchild.cjs')
  const childScript = path.join(dir, 'child.cjs')
  fs.writeFileSync(grandchildScript, GRANDCHILD_JS, 'utf-8')
  fs.writeFileSync(childScript, CHILD_JS, 'utf-8')
  return {
    grandchildScript,
    childScript,
    beatFile: path.join(dir, 'beat.txt'),
    pidFile: path.join(dir, 'pids.json'),
  }
}

describe.skipIf(!isWin)('killProcessTree — Windows 进程树终止', () => {
    it('树杀后根、子、孙三层全部消失（且孙进程心跳停止）', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hclaw-kill-tree-'))
        const {grandchildScript, childScript, beatFile, pidFile} = makeFixtures(dir)
        const root = spawn(
            'cmd.exe',
            ['/c', process.execPath, childScript, grandchildScript, beatFile, pidFile],
            {windowsHide: true, stdio: 'ignore'},
        )
        let tree: TreePids | null = null
        try {
            await waitFor(() => fs.existsSync(pidFile), '三层进程树就位（pid 文件落地）')
            tree = JSON.parse(fs.readFileSync(pidFile, 'utf-8')) as TreePids

            // 前置证据：孙进程确实在跑（心跳文件在增长），否则后面的断言没有意义
            const grown = (): boolean => fs.existsSync(beatFile) && fs.statSync(beatFile).size > 0
            await waitFor(grown, '孙进程心跳文件出现')
            expect(isAlive(tree.child)).toBe(true)
            expect(isAlive(tree.grandchild)).toBe(true)

            killProcessTree(root.pid)

            await waitFor(
                () => !isAlive(tree!.child) && !isAlive(tree!.grandchild) && !isAlive(root.pid!),
                '树杀后三层进程全部消失',
            )

            // 第二重证据：心跳停止（进程真死了，而不是「pid 探测不到但仍活着」）
            const sizeAfterKill = fs.statSync(beatFile).size
            await new Promise((r) => setTimeout(r, 500))
            expect(fs.statSync(beatFile).size).toBe(sizeAfterKill)
        } finally {
            killIfAlive(root.pid)
            killIfAlive(tree?.child)
            killIfAlive(tree?.grandchild)
            try {
                fs.rmSync(dir, {recursive: true, force: true})
            } catch {
                // 临时目录清理失败不影响结论
            }
        }
    }, 30_000)

    it('对照 — 只杀根进程会留下孤儿（cmd 中继场景），故必须在根存活时树杀', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hclaw-orphan-'))
        const beatFile = path.join(dir, 'beat.txt')
        const childPidFile = path.join(dir, 'child.pid')
        const heartbeatScript = path.join(dir, 'heartbeat.cjs')
        fs.writeFileSync(heartbeatScript, HEARTBEAT_JS, 'utf-8')

        // cmd 作中继：外层是根，node 心跳脚本是它拉起的子进程
        const root = spawn(
            'cmd.exe',
            ['/c', process.execPath, heartbeatScript, beatFile, childPidFile],
            {windowsHide: true, stdio: 'ignore'},
        )
        let childPid: number | undefined
        try {
            await waitFor(
                () => fs.existsSync(childPidFile) && fs.existsSync(beatFile) && fs.statSync(beatFile).size > 0,
                '中继子进程心跳已开始',
            )
            childPid = Number(fs.readFileSync(childPidFile, 'utf-8'))
            expect(isAlive(childPid)).toBe(true)

            // 反例：只结束根进程（等价于改造前 exec / 内建 kill 的行为）
            root.kill()
            await waitFor(() => !isAlive(root.pid!), '根进程已退出')

            const sizeAfterRootKill = fs.statSync(beatFile).size
            await new Promise((r) => setTimeout(r, 600))
            expect(isAlive(childPid)).toBe(true)
            expect(
                fs.statSync(beatFile).size,
                '只杀根进程后子进程仍在写心跳 —— 这正是不用内建 kill 的理由',
            ).toBeGreaterThan(sizeAfterRootKill)

            // 收尾：孤儿已随根进程的退出脱离原来的树（taskkill /T 再也遍历不到），只能直接杀
            killProcessTree(childPid)
            await waitFor(() => !isAlive(childPid!), '孤儿进程被清理')
        } finally {
            killIfAlive(root.pid)
            killIfAlive(childPid)
            try {
                fs.rmSync(dir, {recursive: true, force: true})
            } catch {
                // 临时目录清理失败不影响结论
            }
        }
    }, 30_000)

    it('进程已退出后再调一次不抛（幂等兜底），缺 pid 时直接返回', async () => {
        const proc = spawn(process.execPath, ['-e', ''], {windowsHide: true, stdio: 'ignore'})
        await new Promise<void>((resolve) => proc.on('close', () => resolve()))
        expect(isAlive(proc.pid!)).toBe(false)

        expect(() => killProcessTree(proc.pid)).not.toThrow()
        expect(() => killProcessTree(undefined)).not.toThrow()
    }, 15_000)
})
