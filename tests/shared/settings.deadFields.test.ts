/**
 * 死配置清理静态残留测试（spec §2.1 / §3.2）
 *
 * 扫「决策范围内的 5 个文件」+ 设置页默认值源与设置页子树（递归全部 .ts/.tsx）——
 * 注意 bashTool.ts 存在同名参数 `defaultTimeout`，不在本清单内，避免误报；
 * migrations 历史 SQL 保持原样（读取侧容忍多余键）。
 */
import {describe, expect, it} from 'vitest'
import {readdirSync, readFileSync, statSync} from 'fs'
import {resolve} from 'path'

/** 递归列出目录下全部 .ts/.tsx（排除 `*.d.ts`），返回仓库相对路径（/ 分隔）。 */
function walkDir(relDir: string): string[] {
    const out: string[] = []
    for (const name of readdirSync(resolve(process.cwd(), relDir))) {
        const rel = `${relDir}/${name}`
        if (statSync(resolve(process.cwd(), rel)).isDirectory()) out.push(...walkDir(rel))
        else if (/\.tsx?$/.test(name) && !/\.d\.ts$/.test(name)) out.push(rel)
    }
    return out
}

const FILES = [
    'src/shared/types/settings.ts',
    'src/renderer/stores/settingsStore.ts',
    'src/main/agent/manager.impl.ts',
    'src/main/agent/worker.ts',
    'src/main/agent/tools/builtin/systemManageTool.ts',
    'src/shared/settingsDefaults.ts',
    ...walkDir('src/renderer/components/settings'),
]

describe('死配置清理：目标文件无残留', () => {
    it('不含 priorityEnabled / mcpTestTimeout / retryAttempts', () => {
        for (const f of FILES) {
            const src = readFileSync(resolve(process.cwd(), f), 'utf8')
            expect(src, `${f} 残留 priorityEnabled`).not.toContain('priorityEnabled')
            expect(src, `${f} 残留 mcpTestTimeout`).not.toContain('mcpTestTimeout')
            expect(src, `${f} 残留 retryAttempts`).not.toContain('retryAttempts')
        }
    })

    it('不含 subagent 死配置 defaultTimeout（本清单文件内 defaultTimeout 只可能来自死配置）', () => {
        for (const f of FILES) {
            const src = readFileSync(resolve(process.cwd(), f), 'utf8')
            expect(src, `${f} 残留 defaultTimeout`).not.toContain('defaultTimeout')
        }
    })
})
