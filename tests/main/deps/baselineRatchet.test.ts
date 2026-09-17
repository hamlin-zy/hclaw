import {describe, expect, it} from 'vitest'
import fs from 'fs'

/**
 * baseline-ratchet：把「往基线里追加一条豁免」从零成本逃逸变成有声决策。
 *
 * 背景：`.dependency-cruiser-known-violations.json` 记录的是**存量**循环依赖，由
 * `npm run lint:deps` 的 `--ignore-known` 载入豁免。基线匹配语义见
 * `.dependency-cruiser.js` 顶部注释：cycle 违规按「模块集合 + 环长」相同即豁免，
 * 不是端点对；而 depcruise 报出的具体环是 DFS 找到的第一条回到起点的路径，会随
 * 边的增删/重排漂移。因此基线天生会被"顺手重生成一次"这种低成本方式膨胀。
 *
 * 本测试把这个动作变成需要**显式修改本文件里的冻结数字**、从而必然出现在 diff 中被
 * review 的决策；评测主判据仍是 tests/main/deps/circularBoundary.test.ts 的结构不变量
 * （SCC 规模上限 + 禁入环模块）。见
 * docs/superpowers/plans/2026-09-17-main-circular-deps-remediation.md（P4/P5、M2/M3）。
 *
 * 冻结值来源：P1–P4 治理后的实测状态（32 条 → 7 条，旧最大环长 11 → 新最大环长 5）。
 */

const BASELINE_FILE = '.dependency-cruiser-known-violations.json'

/** 基线条目数上限（P4 实测 7，勿在不改本行的情况下重生成基线） */
const FROZEN_MAX_ENTRIES = 7

/** 单条 cycle 的长度上限（旧基线最大 11；P4 实测最大 5，此处按旧上限冻结） */
const FROZEN_MAX_CYCLE_LENGTH = 11

/**
 * 允许出现在基线里的模块全集（P4 审查条件 1：新条目涉及的模块必须来自旧集合）。
 * = 残留两个 SCC 的并集：#1 {agent/manager*, startAgentCore, channel/*, utils/llmCallLogStore}
 * （有意为之的 dynamic-import 设计，明确不拆）+ #2 {window, attention, tray}（UI 联动双向引用）。
 * 出现新模块名即意味着"新的一条环被静默豁免"，必须先在这里显式登记并说明理由。
 */
const KNOWN_CYCLE_MODULES = [
    'src/main/agent/manager.ts',
    'src/main/agent/manager.impl.ts',
    'src/main/agent/startAgentCore.ts',
    'src/main/channel/ChannelManager.ts',
    'src/main/channel/messageHandler.ts',
    'src/main/utils/llmCallLogStore.ts',
    'src/main/attention.ts',
    'src/main/tray.ts',
    'src/main/window.ts',
].sort()

interface BaselineEntry {
    type: string
    from: string
    to: string
    rule: {name: string; severity: string}
    cycle: Array<{name: string; dependencyTypes: string[]}>
}

function readBaseline(): BaselineEntry[] {
    const raw = fs.readFileSync(BASELINE_FILE, 'utf-8')
    const parsed = JSON.parse(raw)
    expect(Array.isArray(parsed), `${BASELINE_FILE} 应为 depcruise baseline 的条目数组`).toBe(true)
    return parsed as BaselineEntry[]
}

describe('baseline-ratchet：循环依赖基线不得膨胀', () => {
    it('条目数、环长、模块集合均在冻结值内', () => {
        const entries = readBaseline()

        expect(entries.length, `基线条目数 ${entries.length} 超过冻结上限 ${FROZEN_MAX_ENTRIES}，`
            + '说明新增的循环依赖被重生成进了基线（应改为修结构，或在 PR 中显式上调本阈值并说明理由）')
            .toBeLessThanOrEqual(FROZEN_MAX_ENTRIES)

        for (const entry of entries) {
            // 基线里只应有 no-circular 的 cycle 条目；非 cycle 条目说明规则集或生成方式变了
            expect(entry.type, `基线出现非 cycle 条目: ${JSON.stringify(entry)}`).toBe('cycle')
            expect(entry.rule?.name).toBe('no-circular')
            expect(entry.cycle.length, `${entry.from} 的环长超过冻结上限`).toBeLessThanOrEqual(FROZEN_MAX_CYCLE_LENGTH)
            expect(entry.cycle.length).toBeGreaterThan(0)
            // 自洽性：depcruise 的 cycle 条目里 from 必然落在该环上
            expect(
                entry.cycle.some(m => m.name === entry.from),
                `${entry.from} 不在自身 cycle 中，基线条目已损坏`,
            ).toBe(true)
        }

        // P4 审查条件 1：不得出现旧集合之外的模块名
        const known = new Set(KNOWN_CYCLE_MODULES)
        const unknown = [...new Set(entries.flatMap(e => e.cycle.map(m => m.name)))].filter(m => !known.has(m)).sort()
        expect(unknown, '基线里出现了 KNOWN_CYCLE_MODULES 之外的模块，等于把新环静默豁免；'
            + '确有必要时请在本文件登记并说明理由').toEqual([])
    })
})
