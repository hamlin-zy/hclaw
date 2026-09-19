import {describe, it, expect} from 'vitest'
import {readFileSync, readdirSync, statSync} from 'fs'
import {join} from 'path'

/**
 * 边框体系统一护栏（2026-09-19 用户拍板：全仓统一）
 *
 * 约定：**选中 / 激活 / hover 强调的容器边框**一律走主题边框体系：
 *   - 强调（选中 / 激活 / hover 强调）→ `--border-emphasis`
 *   - 常规 → `--border`
 * 品牌色（--brand-primary）只用于填充（bg）、文字、指示器（inset 线 / 圆点 / 图标），
 * **不得**作实色容器边框。输入框激活边框的唯一来源是 `INPUT_FOCUS`
 * （src/renderer/lib/inputFocus.ts），任何旁路手工边框都按漂移处理。
 *
 * 背景：统一前全仓漂移出 8+ 处 `border-[var(--brand-primary)]` 选中态
 * （AskUserModal / ModelSelector / ThinkingEffortSelector / LlmLogsWindow /
 *   InputArea / ConversationSidebar / ProjectGroupDrawer / AttachedFilesBar），
 * 与边框体系并行成第二套口径。本测试钉死不允许回流。
 *
 * 豁免：spinner（`border-t-transparent`，转圈动画的填充式描边，非容器边框）。
 */

const ROOT = join(__dirname, '..', '..', 'src', 'renderer')

function* walk(dir: string): Generator<string> {
    for (const name of readdirSync(dir)) {
        const p = join(dir, name)
        const s = statSync(p)
        if (s.isDirectory()) yield* walk(p)
        else if (/\.(tsx?|css)$/.test(name)) yield p
    }
}

describe('边框体系：--brand-primary 不得作实色容器边框', () => {
    it('全仓无 border-[var(--brand-primary)]（spinner 豁免）', () => {
        const offenders: string[] = []
        for (const f of walk(ROOT)) {
            const lines = readFileSync(f, 'utf8').split('\n')
            lines.forEach((line, i) => {
                if (!line.includes('border-[var(--brand-primary)]')) return
                // spinner：转圈动画只描一边，属填充式用法而非容器边框
                if (line.includes('border-t-transparent')) return
                // 用户指令输入框（InputArea 主输入容器）：用户拍板保持品牌色激活边框不变
                // ——该框是全屏输入主容器，激活时强调边框视觉过重（2026-09-19）。其余输入框
                // 的激活边框仍归 INPUT_FOCUS（--border-emphasis）管。
                if (line.includes('input-area-input-box')) return
                // tab 下划线指示条（border-b-2）：与 LlmLogs tab 的 inset 底线同类，
                // 是指示器而非容器边框（约定明示豁免）
                if (line.includes('border-b-2')) return
                offenders.push(`${f.replace(ROOT, 'src/renderer')}:${i + 1}: ${line.trim().slice(0, 120)}`)
            })
        }
        expect(
            offenders,
            '品牌色不得作容器边框（选中/激活/hover 一律 --border-emphasis），如需强调请改边框令牌:\n' + offenders.join('\n'),
        ).toEqual([])
    })
})
