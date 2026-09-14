// 从 git numstat 机械推导 code-simplifier 批次清单（设计 §3.3）
// 用法: node scripts/derive-simplify-batches.mjs [base]   base 默认 origin/develop
import { execSync } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'

const BASE = process.argv[2] || 'origin/develop'
const MAX_ADD = 400, MAX_FILES = 12, MAX_FILES_SHALLOW = 24, SHALLOW_ADD = 30

const EXCLUDE = [
    /^src\/renderer\/assets\//,
    /^package\.json$/,
    /^vite\.main\.config\.mjs$/,
    // Phase 0 自身产出的文件：不在原始 83 个 commit 的范围内，不参与简化
    /^scripts\/audit-stale-tests\.mjs$/,
    /^scripts\/derive-simplify-batches\.mjs$/,
    /^src\/renderer\/components\/dataNameGuard\.registry\.tsx$/,
]

// §4.0 契约组
const CONTRACT = [
    'src/renderer/styles/globals.css', 'tailwind.config.js',
    'src/renderer/index.html', 'src/renderer/dialogWindow.html',
    'src/renderer/main_window/projectManager.html',
    'src/shared/types/theme.ts', 'src/renderer/lib/theme.ts',
    'src/renderer/stores/themeStore.ts', 'src/main/utils/theme.ts',
]

const C12 = ['ConversationSidebar', 'FilePicker', 'InlineCommandPicker', 'InputArea', 'LlmLogsWindow',
    'HandoffDialog', 'LoopWarningBanner', 'InputToolbar', 'PhrasePicker', 'AttachedFilesBar',
    'AskUserModal', 'CommandBadge', 'MenuDialog', 'MainWorkspace']
const C13 = ['PermissionRulesPanel', 'PermissionConfirmModal', 'PermissionModeSelector', 'ToolsChangeModal',
    'MessageDisplayModeSelector', 'ModelSelector', 'ThinkingEffortSelector', 'SchemeSelector', 'ThemedSelect',
    'ThemedCombobox', 'SessionStats', 'StepsBlock', 'TitleBar', 'TodoStrip', 'CacheRateTooltip',
    'ConfirmDialog', 'DiffModal', 'PendingQuestionCard', 'BrowserShellWindow', 'ConfigDialogWindow']

const base = f => path.posix.basename(f)

// 按顺序匹配，首个命中即归属
const CLUSTERS = [
    ['C15', 2, f => CONTRACT.includes(f)],
    ['C1', 1, f => /^src\/main\/agent\/utils\/image/.test(f) || /^src\/main\/agent\/tools\/builtin\/loadImage/.test(f)],
    ['C5', 1, f => /^src\/main\/agent\/mcp\/pluginServers/.test(f)],
    ['C3', 1, f => /^src\/main\/agent\/mcp\/(client|ipc|mcpWorkerManager|types)/.test(f)],
    ['C4', 1, f => /^src\/main\/agent\/mcp\/(discovery|versionManager|versionUtils)/.test(f)],
    ['C2', 1, f => /^src\/shared\//.test(f)],
    ['C6', 1, f => /^src\/main\/agent\/defaults\//.test(f)],
    ['C16', 3, f => /^(eslint-rules\/|scripts\/audit-muted-text|eslint\.config\.ts)/.test(f)],
    ['C7', 1, f => /^src\/main\//.test(f)],
    ['C9', 2, f => /^src\/renderer\/components\/dialogs\//.test(f)],
    ['C11', 2, f => /^src\/renderer\/components\/message-list\/(compact-popup\/|utils\/displaySegments|config\/toolStatusConfig)/.test(f)],
    ['C10', 2, f => /^src\/renderer\/components\/message-list\//.test(f)],
    ['C8', 2, f => /^src\/renderer\/(stores\/|project-manager\/|App\.tsx|utils\/handoff)/.test(f)],
    ['C14', 2, f => /^src\/renderer\/components\/(icons|skill|memo|usage|common|plugin|llmTrace|settings|repo)\//.test(f)],
    ['C12', 2, f => /^src\/renderer\/components\/[^/]+$/.test(f) && C12.includes(base(f).replace(/\.tsx$/, ''))],
    ['C13', 2, f => /^src\/renderer\/components\/[^/]+$/.test(f) && C13.includes(base(f).replace(/\.tsx$/, ''))],
    ['C17', 4, f => /^tests\//.test(f)],
]

const rows = execSync(`git diff --numstat ${BASE}...HEAD`, { encoding: 'utf8' })
    .trim().split('\n').map(l => l.split('\t'))
    .map(([a, d, p]) => ({ add: +a, del: +d, path: p.replace(/\\/g, '/') }))
    .filter(f => f.add > 0 && !EXCLUDE.some(re => re.test(f.path)))

const groups = new Map()
const orphans = []
for (const f of rows) {
    const hit = CLUSTERS.find(([, , test]) => test(f.path))
    if (!hit) { orphans.push(f); continue }
    const [id, phase] = hit
    if (!groups.has(id)) groups.set(id, { phase, files: [] })
    groups.get(id).files.push(f)
}

function split(id, files) {
    const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path))
    const out = []; let cur = [], add = 0
    const flush = () => { if (cur.length) { out.push({ files: cur, add }); cur = []; add = 0 } }
    for (const f of sorted) {
        const nextAllShallow = [...cur, f].every(x => x.add <= SHALLOW_ADD)
        const limit = nextAllShallow ? MAX_FILES_SHALLOW : MAX_FILES
        if (cur.length && (add + f.add > MAX_ADD || cur.length + 1 > limit)) flush()
        cur.push(f); add += f.add
    }
    flush()
    return out.map((b, i) => ({ id: out.length > 1 ? `${id}-${i + 1}` : id, ...b }))
}

const md = ['# code-simplifier 批次清单（机械推导）', '',
    `- 基准：\`${BASE}...HEAD\` @ ${execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim()}`,
    `- 规则：add>0 / 单批 add<=${MAX_ADD} / 文件<=${MAX_FILES}（全浅改<=${MAX_FILES_SHALLOW}）`,
    `- 契约组：命中即门禁追加 themeTokenSync + settingsThemeSync + npm run build`, '']

let n = 0
for (const id of ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C9', 'C10', 'C11', 'C12', 'C13', 'C14', 'C15', 'C16']) {
    const g = groups.get(id)
    if (!g) { md.push(`## ${id} — ⚠️ 未匹配到任何文件（规则或路径有变，需人工核对）`, ''); continue }
    for (const b of split(id, g.files)) {
        n++
        const contract = b.files.some(f => CONTRACT.includes(f.path))
        md.push(`## B${n} — 簇 ${b.id} · Phase ${g.phase} · add=${b.add} · ${b.files.length} 文件${contract ? ' · ⚠️ 契约组' : ''}`, '')
        for (const f of b.files) md.push(`- [ ] \`${f.path}\` (add ${f.add} del ${f.del})`)
        md.push('')
    }
}
if (orphans.length) {
    md.push(`## ⚠️ 未归属文件（${orphans.length}）— 必须人工归簇后再执行`, '')
    for (const f of orphans) md.push(`- \`${f.path}\` (add ${f.add})`)
    md.push('')
}
md.push(`## 合计：${n} 批`, '')

mkdirSync(path.join(process.cwd(), 'docs/superpowers/plans'), { recursive: true })
writeFileSync(path.join(process.cwd(), 'docs/superpowers/plans/2026-09-13-simplify-batches.md'), md.join('\n'), 'utf8')
console.log(md.join('\n'))
console.log(`\n总计 ${n} 批；未归属 ${orphans.length} 个文件。`)
