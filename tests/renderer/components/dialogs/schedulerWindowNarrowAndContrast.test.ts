/**
 * 调度窗口（ui-09）· 窄宽度降级与文字对比度
 *
 * 为什么是「源码/DOM 断言」而不是像素断言：jsdom 不做布局（`scrollWidth`/`clientWidth`
 * 恒为 0），任何「有没有横向滚动条」的运行时断言在这里都是恒真/恒假的假证据。
 * 能真正钉住的只有两件事，本文件就钉这两件：
 *
 *  1. **断点只用 md:/lg:**（X8）——出现 sm:/xl:/2xl: 意味着悄悄扩了断点体系；
 *  2. **调度窗口里的小字颜色只取受对比度门禁的令牌**（C2/C7）——`--brand-primary`、
 *     Tailwind 原生调色板类名都在禁止之列（前者在 `.yuanshandai` 下会掉到 1.58:1，
 *     后者的取值不随主题变化）。
 *
 * 另外两条结构性护栏（同样是「降级」的机械判据）：
 *  - 编辑弹窗「名称 + 描述」并排区：窄处 `flex-col`、宽处 `md:flex-row`；
 *  - 列表行第二行（元信息）就地裁切（`overflow-hidden`），不让定宽片段把列表撑出横向滚动。
 */
import {describe, it, expect} from 'vitest'
import {readFileSync} from 'fs'
import {join} from 'path'

const ROOT = process.cwd()

/** 本窗口的全部源文件（ui-09 涉及范围） */
const WINDOW_FILES = [
    'src/renderer/components/dialogs/ScheduleDialog.tsx',
    'src/renderer/components/dialogs/ScheduleEditModal.tsx',
    'src/renderer/components/dialogs/ScheduleCard.tsx',
    'src/renderer/components/dialogs/ScheduleListStates.tsx',
    'src/renderer/components/dialogs/ScheduleConversationsPanel.tsx',
    'src/renderer/components/dialogs/ScheduleScriptLogPanel.tsx',
    'src/renderer/components/dialogs/ScheduleUtils.ts',
    'src/renderer/hooks/useScheduleListState.ts',
    'src/renderer/hooks/useScheduleFormState.ts',
    // ui-09 复核整改：这两个组件被 ScheduleEditModal 直接 import 并在本窗口内渲染，
    // 属同一判据面，却在 WINDOW_FILES 里缺席（覆盖盲区）。补进后本文件的静态规则
    // （断点体系 + 小字颜色只取受门禁令牌）对它们一并生效。
    'src/renderer/components/common/CapabilityPicker.tsx',
    'src/renderer/components/ThemedSelect.tsx',
]

/** 注释里的类名不是类名：先剥注释再扫 */
function stripComments(src: string): string {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^[ \t]*\/\/.*$/gm, '')
}

function read(f: string): string {
    return stripComments(readFileSync(join(ROOT, f), 'utf-8'))
}

/** 逐行扫描，返回 `file:line: 原文` 形式的命中 */
function scanLines(files: string[], hit: (line: string) => boolean): string[] {
    const out: string[] = []
    for (const f of files) {
        read(f).split('\n').forEach((line, i) => {
            if (hit(line)) out.push(`${f}:${i + 1}: ${line.trim()}`)
        })
    }
    return out
}

/** 受 `scripts/audit-contrast.mjs` 门禁的文字级令牌（四主题 × 三种底色 ≥ 4.5:1） */
const GATED_TEXT_TOKEN =
    /^text-\[var\(--(?:text-(?:primary|secondary|muted|danger)|ft-[a-z]+)\)\]$/

/** 与颜色无关的 `text-*` 工具类（字号 / 对齐 / 截断 …），不属于颜色判定范围 */
const NON_COLOR_TEXT_UTIL =
    /^text-(?:xs|sm|2xs|base|lg|left|center|right|start|end|ellipsis|nowrap|wrap|balance|clip|transparent|current|inherit|\[\d+(?:\.\d+)?(?:px|rem|em|%)\]|\d+px)$/

/** 品牌/语义实底上的白字（设计系统规定的承白字实底，见 tokenCompliance 的豁免 1） */
const BRAND_SOLID_BG = /bg-\[var\(--(?:brand-primary|brand-ink|brand-ink-hover|error|warning|success)\)\]/

describe('窄宽度只降级：断点体系不扩张（X8）', () => {
    it('调度窗口内不出现 md:/lg: 之外的断点', () => {
        const hits = scanLines(WINDOW_FILES, line => /(?:^|[^a-zA-Z-])(?:sm|xl|2xl):/.test(line))
        expect(hits, `出现了 md:/lg: 之外的断点（X8：不新增断点体系）:\n${hits.join('\n')}`).toEqual([])
    })

    it('编辑弹窗的「名称 + 描述」并排区在窄宽度下是单栏、只在 md: 及以上并排', () => {
        const src = read('src/renderer/components/dialogs/ScheduleEditModal.tsx')
        const row = src.split('\n').find(l => l.includes('schedule-edit-modal-name-row'))
        expect(row, '找不到「名称 + 描述」并排区的容器').toBeTruthy()
        expect(row).toContain('flex-col')
        expect(row).toContain('md:flex-row')
    })

    it('列表行的元信息行就地裁切，不让定宽片段把列表撑出横向滚动', () => {
        const src = read('src/renderer/components/dialogs/ScheduleCard.tsx')
        const lines = src.split('\n')
        // className 与 data-name 分处两行（多行 JSX 属性），故连同前一行一起看
        const at = lines.findIndex(l => l.includes('schedule-dialog-meta'))
        expect(at, '找不到行内元信息行').toBeTruthy()
        expect(lines.slice(Math.max(0, at - 2), at + 1).join('\n')).toContain('overflow-hidden')
    })
})

describe('浅色 / 深色主题下小字对比度达标（C2 / C7）', () => {
    it('调度窗口内的小字颜色只取受门禁的文字级令牌（不含 --brand-primary、不含调色板类名）', () => {
        const offenders: string[] = []
        for (const f of WINDOW_FILES) {
            read(f).split('\n').forEach((line, i) => {
                // 取该行里所有 `text-…` 令牌（含 `hover:text-…` / `focus:text-…` 变体）
                // 负向后视排除 --text-… / placeholder-[var(--text-…)] 里的同名字串：
                // 只认独立的 	ext-* 工具类，不认别的属性值里的 token 名
                const tokens = line.match(/(?<![-\w[])text-(?:\[[^\]]+\]|[A-Za-z0-9-]+)/g) ?? []
                for (const raw of tokens) {
                    const token = raw.replace(/^(?:[a-z-]+:)+/, '')
                    if (GATED_TEXT_TOKEN.test(token)) continue
                    if (NON_COLOR_TEXT_UTIL.test(token)) continue
                    // 白字压在品牌/语义实底上：设计系统规定的可读组合，放行
                    if (token === 'text-white' && BRAND_SOLID_BG.test(line)) continue
                    offenders.push(`${f}:${i + 1}: ${token}  ←  ${line.trim().slice(0, 100)}`)
                }
            })
        }
        expect(
            offenders,
            '小字用了未受对比度门禁覆盖的颜色（应改用 --text-primary/--text-secondary/--text-muted/--text-danger/--ft-*）:\n' +
                offenders.join('\n'),
        ).toEqual([])
    })
})
