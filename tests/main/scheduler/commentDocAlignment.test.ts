/**
 * core-10 — 注释与文档的对齐守卫
 *
 * 本票（core-10）的唯一价值是「文档/注释与实现一致」，而一致性最容易在下一次改动里悄悄失效：
 * 方法改名、文件搬家、通道改名、截图被删、术语回潮，都不会让任何行为测试变红。
 * 本文件把这些「不写代码就会漂」的约束钉成静态断言，手法沿先例
 * tests/main/scheduler/silentFailureContract.test.ts 与 scheduleChangeBroadcast.test.ts 的 readSrc。
 *
 * 五条规则（每条都独立可失败）：
 * 1. **注释里被反引号包起来的标识符必须真实存在**：在产品源码（src/）的声明索引里可解析。
 *    防的是「注释声称有个 writeScriptLog / updateRunStatusSafe，其实早就改名了」。
 * 2. **注释里被反引号包起来的 kebab 名（IPC 通道名）必须以字符串字面量出现在源码里**。
 * 3. **注释里被反引号包起来的路径必须解析到真实文件**（含 `@shared/*`、`@/*`、相对路径与省略扩展名）。
 * 4. **docs/scheduler.md 引用的截图必须存在**（不许引用仓库里没有的图片）。
 * 5. **docs/scheduler.md 不得使用 CONTEXT.md「定时任务域」列为 _Avoid_ 的词**。
 *
 * 规则 6–8（本轮补齐的三处覆盖缺口，各自独立可失败）：
 * 6. **`schedulerManageTool.description` 声称的动作名必须都在 `inputSchema` 的 action 枚举里**。
 *    防的是「模型被告知能做停止，工具却根本没有这个动作」——属于**模型可见行为**与实现的漂移，
 *    任何行为测试都不会变红（模型看到的只是一段文案）。
 * 7. **文档数字 ↔ 代码常量一致**：docs/scheduler.md 里的事实性数字（重建延迟 / 轮询间隔 /
 *    脚本输出缓冲上限 / 日志显示上限）与实现常量**同源**——断言先读出常量值，再要求文档含由
 *    该值生成的片段。防的正是「把『约 5 秒』改成『约 4 小时』守卫仍全绿」。
 * 8. **反引号 token 里的字符串字面量必须真实存在**：token 内被引号包住的片段要在产品源码的
 *    代码区出现（覆盖既非标识符、又非 kebab、也非路径形的 token 的一部分）。
 *
 * 受管文件 = 定时任务域的全部实现文件 + 对外文档。新增实现文件请一并登记到 MANAGED：
 * 规则 1 的「扫描面非空」断言会核对登记数与目录实际文件数，漏登记即红。
 *
 * **剩余盲区**（记录在案，避免读者高估守卫强度）：
 * - 反引号 token 的规则覆盖率**仍非 100%**：既非标识符、又非 kebab 名、也非路径形、且内部
 *   不含字符串字面量的 token（纯表达式如 `setLogs([])`、`await reload()`、自然语言片段）
 *   不被任何一条规则覆盖，写错也不会红（规则 8 只补上「内部含引号片段」的那部分）。
 * - 文档数字断言只覆盖**已登记的四个常量**：文档里其它事实性数字（如「最多 8 位短 id」一类）
 *   仍无人核对；新增常量请一并登记到规则 7 的用例里。
 */
import {describe, expect, it} from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

const ROOT = process.cwd()

/** 受管文件（仓库根相对 POSIX 路径）：定时任务域实现 + 对外文档 */
const MANAGED_SOURCES = [
    'src/main/scheduler/SchedulerEngine.ts',
    'src/main/scheduler/ScheduleRepository.ts',
    'src/main/scheduler/scheduleIPC.ts',
    'src/main/scheduler/scheduleOps.ts',
    // 票 11 新增：工作目录判定的唯一权威（执行拦截与健康度查询共用）
    'src/main/scheduler/scheduleWorkspace.ts',
    'src/main/scheduler/scheduleBroadcast.ts',
    'src/main/scheduler/scheduleErrors.ts',
    'src/main/scheduler/index.ts',
    // 记忆沉淀前置探针：无待办时本地短路（判定口径与 systemSchedules.ts 的步骤 1 同源）
    'src/main/scheduler/memoryProbe.ts',
    'src/main/scheduler/scriptLogPath.ts',
    'src/main/scheduler/worker.ts',
    'src/main/agent/tools/builtin/schedulerManageTool.ts',
    'src/renderer/stores/scheduleStore.ts',
    'src/renderer/hooks/useScheduleListState.ts',
    'src/renderer/components/dialogs/ScheduleScriptLogPanel.tsx',
    'src/shared/types/schedule.ts',
]

const DOCS = 'docs/scheduler.md'
const CONTEXT = 'CONTEXT.md'
/** 规则 6 的被检文件：模型可见的运行时文案与 action 枚举都在这里 */
const MANAGE_TOOL = 'src/main/agent/tools/builtin/schedulerManageTool.ts'

const abs = (p: string) => path.join(ROOT, p)
const read = (p: string) => fs.readFileSync(abs(p), 'utf-8')

/**
 * 单遍扫描源码，把「代码区」与「注释」分开。
 *
 * 用状态机而不是正则去块注释：正则版会把**字符串里的「斜杠星号」两字符**
 * 当成块注释起始，吞掉其后直到下一个「星号斜杠」的全部内容。
 * 实测本仓有 40 个文件的声明因此被吞（如 `globTool.ts` 里那段含该两字符的
 * glob 模式说明字符串，吞掉了其后的 `GlobInput`、`globTool`），
 * 方向是「索引变小 → 合法引用被误报为漂移」。
 * 状态机在字符串/模板串内不识别注释起始。
 *
 * 行注释沿用既有启发式：`//` 前必须是行首或空白，且第三个字符不是 `/`——
 * 这样 `https://`（前一字符是 `:`）与 `///` 不会被当成注释。
 */
function scanSource(src: string): {code: string, comments: string} {
    let code = ''
    let comments = ''
    let i = 0
    let state: 'code' | 'line' | 'block' = 'code'
    while (i < src.length) {
        const c = src[i]
        if (state === 'code') {
            if (c === "'" || c === '"' || c === '`') {
                // 字符串 / 模板串：整段原样进入代码区，内部不识别注释起始
                const quote = c
                code += c
                i++
                while (i < src.length) {
                    const d = src[i]
                    if (d === '\\') { code += d + (src[i + 1] ?? ''); i += 2; continue }
                    code += d
                    i++
                    if (d === quote) break
                }
                continue
            }
            if (c === '/' && src[i + 1] === '*') { state = 'block'; comments += ' '; i += 2; continue }
            if (c === '/' && src[i + 1] === '/' && src[i + 2] !== '/'
                && (i === 0 || src[i - 1] === '\n' || /[^\S\n]/.test(src[i - 1]))) {
                state = 'line'; comments += ' '; i += 2; continue
            }
            code += c
            i++
        } else if (state === 'line') {
            if (c === '\n') state = 'code'
            else comments += c
            i++
        } else {
            if (c === '*' && src[i + 1] === '/') { state = 'code'; i += 2; continue }
            comments += c
            i++
        }
    }
    return {code, comments}
}

/** 收集一个源文件里的全部注释（块注释 + 行注释），供反引号 token 抽取使用 */
function commentsOf(src: string): string {
    return scanSource(src).comments
}

/** 抹掉注释后的代码区——「符号是否真被声明/真被写成字面量」只认代码区 */
function codeOf(src: string): string {
    return scanSource(src).code
}

/** 注释里被反引号包起来、且**不含换行**的 token */
function quotedTokens(src: string): string[] {
    return [...new Set([...commentsOf(src).matchAll(/`([^`\n]+)`/g)].map(m => m[1]))]
}

const IDENT = /^[A-Za-z_$][\w$]*$/
/** kebab 名（IPC 通道名一类的字面量），如 `schedules-changed` */
const KEBAB = /^[a-z][a-z0-9]*(-[a-z0-9]+)+$/
/** 路径形 token：含 `/`、不含空白与模板插值字符 */
const PATHISH = /^[@A-Za-z._][A-Za-z0-9@._/-]*$/

/** TS / JS 关键字与全局对象——不是「本仓声明的符号」，不参与规则 1 */
const NOT_A_SYMBOL = new Set([
    'true', 'false', 'null', 'undefined', 'void', 'this', 'super', 'new', 'typeof', 'instanceof',
    'as', 'is', 'keyof', 'in', 'of', 'for', 'while', 'if', 'else', 'switch', 'case', 'break',
    'continue', 'try', 'catch', 'finally', 'throw', 'return', 'await', 'async', 'yield',
    'class', 'interface', 'type', 'enum', 'function', 'const', 'let', 'var', 'import', 'export',
    'default', 'extends', 'implements', 'readonly', 'public', 'private', 'protected', 'static',
    'declare', 'abstract', 'override', 'get', 'set', 'from', 'require', 'module', 'exports',
    'console', 'process', 'JSON', 'Math', 'Object', 'Array', 'Promise', 'Set', 'Map', 'WeakMap',
    'Error', 'Date', 'String', 'Number', 'Boolean', 'RegExp', 'Pick', 'Omit', 'Partial', 'Record',
    'Exclude', 'Extract', 'Readonly', 'NonNullable', 'ReturnType', 'Parameters', 'Awaited',
])

function walk(dir: string, out: string[] = []): string[] {
    for (const e of fs.readdirSync(abs(dir), {withFileTypes: true})) {
        if (e.name === 'node_modules' || e.name === '.git' || e.name === '.vite') continue
        const child = `${dir}/${e.name}`
        if (e.isDirectory()) walk(child, out)
        else if (/\.tsx?$/.test(e.name)) out.push(child)
    }
    return out
}

/**
 * 产品源码 —— 规则 1（声明索引）与规则 2（字面量）共用的查找面。**不含 tests/**。
 *
 * 规则 1 曾把 tests/ 一并收进索引（约 14398 个名字），那会制造「测试影子索引」：
 * 注释里写一个**只存在于测试文件**的名字也能通过，断言被稀释。实测收窄到 src/
 * 后，受管文件的合法引用没有任何一条被误报（offenders 为空），故收窄。
 */
const SRC_FILES = walk('src').sort()

/**
 * 声明索引：产品源码里「被定义过」的标识符集合。
 *
 * 覆盖的声明形态：顶层/嵌套声明（class|interface|type|enum|function|const|let|var）、
 * 类方法、类字段、对象/接口属性、import 绑定、数组解构绑定。
 * 这是**宽松**的解析底座——宁可放过一个同名局部变量，也不误报合法引用；
 * 它拦的是「src/ 里搜不到这个名字」，也就是改名/删除后注释没跟上的情形。
 */
function declarationIndex(): Set<string> {
    const names = new Set<string>()
    const add = (n?: string) => { if (n) names.add(n.trim()) }
    for (const file of SRC_FILES) {
        const code = codeOf(read(file))
        for (const m of code.matchAll(/\b(?:class|interface|type|enum|function|const|let|var)\s+([A-Za-z_$][\w$]*)/g)) add(m[1])
        // 类方法 / 函数声明
        for (const m of code.matchAll(/^\s+(?:(?:public|private|protected|static|readonly|async|get|set|declare|abstract|override)\s+)*([A-Za-z_$][\w$]*)\s*\(/gm)) add(m[1])
        // 对象/接口属性
        for (const m of code.matchAll(/(?:^|[\s{(,])([A-Za-z_$][\w$]*)\??\s*:/gm)) add(m[1])
        // 类字段 / 普通赋值
        for (const m of code.matchAll(/(?:^|[\s{(,])(?:(?:public|private|protected|static|readonly|declare|override|abstract)\s+)*([A-Za-z_$][\w$]*)\s*=(?!=)/gm)) add(m[1])
        // 数组解构绑定：const [a, setA] = ...
        for (const m of code.matchAll(/\[([^\]\n]*)\]\s*=/g)) {
            for (const part of m[1].split(',')) add(part.trim().replace(/\s*=.*$/, ''))
        }
        // import 绑定（具名 / 默认 / 命名空间）
        for (const m of code.matchAll(/\bimport\s+(?:type\s+)?\{([^}]*)\}\s*from/g)) {
            for (const part of m[1].split(',')) add(part.replace(/\btype\s+/, '').split(/\s+as\s+/).pop())
        }
        for (const m of code.matchAll(/\bimport\s+([A-Za-z_$][\w$]*)\s*(?:,|from)/g)) add(m[1])
    }
    return names
}

/** 把注释里的路径 token 解析成真实文件；解析不到即视为漂移 */
function resolvePathToken(token: string, fromFile: string): boolean {
    const candidates: string[] = []
    const dir = path.posix.dirname(fromFile)
    if (token.startsWith('@shared/')) candidates.push(`src/shared/${token.slice('@shared/'.length)}`)
    else if (token.startsWith('@/')) candidates.push(`src/${token.slice(2)}`)
    else if (token.startsWith('.')) candidates.push(path.posix.normalize(path.posix.join(dir, token)))
    else candidates.push(token, `src/${token}`, `src/main/${token}`, `src/renderer/${token}`,
        `src/shared/${token}`, `tests/${token}`)
    const suffixes = ['', '.ts', '.tsx', '.md', '/index.ts', '/index.tsx']
    return candidates.some(c => suffixes.some(s => fs.existsSync(abs(c + s))))
}

/**
 * 某个字符串字面量是否出现在产品源码的**代码区**里（规则 2 用）。
 *
 * 只认代码区：若把注释也算进来，「在注释里被反引号引用一次」就足以自我证真 ——
 * 规则会退化成恒真。反引号形式同样不认，只认真正的字符串字面量。
 */
function isQuotedInSource(token: string): boolean {
    return SRC_FILES.some(f => {
        const code = codeOf(read(f))
        return code.includes(`'${token}'`) || code.includes(`"${token}"`)
    })
}

/**
 * 抽 `schedulerManageTool` 的两件事实：运行时 description 文案、action 枚举取值（规则 6 用）。
 *
 * 都只认代码区（注释不算数），且 description 的取值区间锚在 `name: 'scheduler_manage',` 之后、
 * `inputSchema,` 之前——inputSchema 内部也有一个 `description:` 字段，不锚定会取错。
 */
function manageToolFacts(): {actions: string[]; desc: string} {
    const code = codeOf(read(MANAGE_TOOL))
    const enumSrc = code.match(/action:\s*z\.enum\(\[([^\]]*)\]\)/)
    const actions = enumSrc ? [...enumSrc[1].matchAll(/'([^']+)'/g)].map(m => m[1]) : []
    const seg = code.match(/name:\s*'scheduler_manage',([\s\S]*?)inputSchema,/)
    const desc = seg ? [...seg[1].matchAll(/'((?:[^'\\]|\\.)*)'/g)].map(m => m[1]).join('') : ''
    return {actions, desc}
}

/**
 * description 里的中文动作词 → 它声称的 action 枚举值（规则 6 的词表）。
 *
 * 只对**动作词**建表：`停止 / 暂停 / 恢复` 三个动作在工具面上并不存在（见文件头「边界」），
 * 一旦描述里出现即判红。匹配顺序无关紧要（各词互不包含）。
 */
const ACTION_WORDS: Array<[string, string]> = [
    ['立即执行', 'run_now'],
    ['停止', 'stop'],
    ['暂停', 'pause'],
    ['恢复', 'resume'],
    ['列出', 'list'],
    ['查看', 'get'],
    ['创建', 'create'],
    ['新建', 'create'],
    ['更新', 'update'],
    ['删除', 'delete'],
]

/** 从源码里读出某个数值常量；模式失配即视为「守卫本身失焦」，直接判红而不是静默跳过 */
function numberFrom(src: string, pattern: RegExp, label: string): number {
    const m = src.match(pattern)
    expect(m, `${label}：未能在源码中识别该常量（守卫已失焦，需同步更新模式）`).toBeTruthy()
    return Number(m![1].replace(/_/g, ''))
}

/** CONTEXT.md 里某一域的词条（`## X域...` 到下一个 `##` 为止） */function contextSection(domain: string): string {
    const src = read(CONTEXT)
    const start = src.indexOf(`## ${domain}`)
    if (start < 0) return ''
    const rest = src.slice(start + 3)
    const next = rest.indexOf('\n## ')
    return next < 0 ? rest : rest.slice(0, next)
}

/** 该域里 `_Avoid_:` 列出的禁用词（顿号分隔的条目） */
function avoidWords(domain: string): string[] {
    const out: string[] = []
    for (const m of contextSection(domain).matchAll(/_Avoid_:\s*([^\n]+)/g)) {
        for (const w of m[1].split('、')) {
            const t = w.trim()
            if (t) out.push(t)
        }
    }
    return out
}

describe('core-10 守卫 — 扫描面非空', () => {
    it('受管文件全部存在，且登记数与定时任务目录的实际文件数一致', () => {
        for (const f of MANAGED_SOURCES) expect(fs.existsSync(abs(f)), `${f} 不存在`).toBe(true)
        // 漏登记即红：目录里新增实现文件必须纳入本契约
        const inDir = fs.readdirSync(abs('src/main/scheduler'), {recursive: true})
            .map(f => String(f).replace(/\\/g, '/'))
            .filter(f => f.endsWith('.ts'))
            .map(f => `src/main/scheduler/${f}`)
            .sort()
        expect(MANAGED_SOURCES.filter(f => f.startsWith('src/main/scheduler/')).sort()).toEqual(inDir)
    })

    it('注释里确实抽到了 token（抽取逻辑空转时，后面几条断言会变成永真）', () => {
        const total = MANAGED_SOURCES.reduce((n, f) => n + quotedTokens(read(f)).length, 0)
        expect(total).toBeGreaterThanOrEqual(15)
        // 反例：没有反引号就抽不到东西
        expect(quotedTokens('/* 纯文本，无引用 */')).toEqual([])
    })
})

describe('core-10 守卫 — 注释里的反引号 token 必须真实存在', () => {
    const names = declarationIndex()

    it('标识符：每个反引号标识符都能在本仓的声明索引里解析', () => {
        const offenders: string[] = []
        for (const file of MANAGED_SOURCES) {
            for (const token of quotedTokens(read(file))) {
                if (token.includes('/')) continue          // 路径归下一条管
                if (!IDENT.test(token)) continue           // kebab / 片段归再下一条管
                if (NOT_A_SYMBOL.has(token)) continue
                if (!names.has(token)) offenders.push(`${file} → \`${token}\``)
            }
        }
        expect(offenders).toEqual([])
    })

    it('kebab 名（IPC 通道名一类）必须以字符串字面量出现在源码里', () => {
        const offenders: string[] = []
        for (const file of MANAGED_SOURCES) {
            for (const token of quotedTokens(read(file))) {
                if (!KEBAB.test(token)) continue
                if (!isQuotedInSource(token)) offenders.push(`${file} → \`${token}\``)
            }
        }
        expect(offenders).toEqual([])
    })

    it('路径：每个反引号路径都能解析到真实文件', () => {
        const offenders: string[] = []
        for (const file of MANAGED_SOURCES) {
            for (const token of quotedTokens(read(file))) {
                if (!token.includes('/') || !PATHISH.test(token)) continue
                if (!resolvePathToken(token, file)) offenders.push(`${file} → \`${token}\``)
            }
        }
        expect(offenders).toEqual([])
    })

    it('字符串里的「斜杠星号」不吞掉其后的声明（状态机 vs 正则的回归点）', () => {
        // 尾随真块注释提供了「星号斜杠」这一闭合点：正则版会从字符串内的
        // 「斜杠星号」一路吞到它，把中间两条声明一并抹掉（实测旧实现 GlobInput/globTool 均丢失）。
        const src = [
            'const pattern = \'glob 模式，例如 "**/*.ts"\'',
            'export interface GlobInput { pattern: string }',
            'export const globTool = 1',
            '/* 真块注释 */',
            'export const tail = 2',
        ].join('\n')
        const {code} = scanSource(src)
        expect(code).toContain('GlobInput')
        expect(code).toContain('globTool')
        expect(code).toContain('tail')
        // 真注释仍要被抹掉（块注释与行注释各自的关键字都不留在代码区）
        const mixed = scanSource("const a = 1 // ghostLineToken\n/* ghostBlockToken */\nconst b = 2")
        expect(mixed.code).toContain('const a')
        expect(mixed.code).toContain('const b')
        expect(mixed.code).not.toContain('ghostLineToken')
        expect(mixed.code).not.toContain('ghostBlockToken')
    })

    it('解析器本身是有效的：改动一个不存在的符号会被判红（反例自查）', () => {
        // 直接喂假 token 走同一套判定，确认「不存在 ⇒ 报违规」这条逻辑不是恒真
        expect(names.has('thisSymbolWasNeverDeclaredAnywhere')).toBe(false)
        expect(resolvePathToken('src/main/scheduler/doesNotExist.ts', 'src/main/scheduler/index.ts')).toBe(false)
        expect(isQuotedInSource('no-such-channel-name')).toBe(false)
    })
})

describe('core-10 守卫 — 对外文档', () => {
    it('docs/scheduler.md 引用的截图必须存在', () => {
        const src = read(DOCS)
        const refs = [...src.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)].map(m => m[1])
        expect(refs.length).toBeGreaterThan(0)
        const missing = refs.filter(r => !fs.existsSync(path.join(path.dirname(abs(DOCS)), r)))
        expect(missing).toEqual([])
    })

    it('docs/scheduler.md 不使用「定时任务域」列为 _Avoid_ 的词', () => {
        const doc = read(DOCS)
        const words = avoidWords('定时任务域')
        // 词表必须真的解析出来了，否则这条断言会变成空转
        expect(words.length).toBeGreaterThanOrEqual(10)
        const used = words.filter(w => doc.includes(w))
        expect(used).toEqual([])
    })

    it('CONTEXT.md 的「定时任务域」覆盖本轮新增术语', () => {
        const section = contextSection('定时任务域')
        expect(section).toContain('暂停（Pause）/ 恢复（Resume）')
        expect(section).toContain('脚本日志（Script Log）')
        // 触发来源已由 core-05 落地：`'cron' | 'manual'` 为唯一来源，旧的「已知待修项」措辞必须消失
        expect(section).toContain('ScheduleFireSource')
        expect(section).not.toContain('已知待修项')
    })
})

describe('core-10 守卫（规则 6）— 工具 description 不得声称不存在的 action', () => {
    it('description 里的动作名必须都在 inputSchema 的 action 枚举里', () => {
        const {actions, desc} = manageToolFacts()
        // 先把枚举钉住：规则若取不到枚举就退化成恒真
        expect(actions).toEqual(['list', 'get', 'create', 'update', 'delete', 'run_now'])
        expect(desc.length).toBeGreaterThan(20)

        const claimed = ACTION_WORDS.filter(([word]) => desc.includes(word))
        // 抽取逻辑空转会变成永真：描述里至少要能认出 3 个动作词
        expect(claimed.length).toBeGreaterThanOrEqual(3)

        const offenders = claimed
            .filter(([, action]) => !actions.includes(action))
            .map(([word, action]) => `${MANAGE_TOOL} → description 声称「${word}」⇒ action=${action}，但枚举里没有 ${action}`)
        expect(offenders).toEqual([])
    })

    it('判定不是恒真：描述里出现「停止」会被判红（反例自查）', () => {
        const {actions} = manageToolFacts()
        const withStop = '定时任务管理。支持列出所有任务、立即执行或停止任务。'
        const offenders = ACTION_WORDS
            .filter(([word]) => withStop.includes(word))
            .filter(([, action]) => !actions.includes(action))
        expect(offenders.map(([w]) => w)).toEqual(['停止'])
    })
})

describe('core-10 守卫（规则 7）— 文档数字必须与代码常量同源', () => {
    const doc = () => read(DOCS)

    it('后台引擎重建延迟：文档「约 N 秒」取自 scheduler/index.ts 的重启定时器', () => {
        const ms = numberFrom(read('src/main/scheduler/index.ts'),
            /this\.restartTimer = setTimeout\([\s\S]*?\},\s*(\d+)\)/, 'worker 重建延迟')
        expect(ms).toBeGreaterThan(0)
        expect(ms % 1000).toBe(0)
        expect(doc()).toContain(`约 ${ms / 1000} 秒后自动把它重新建起来`)
    })

    it('引擎轮询间隔：文档「引擎每秒轮询一次」取自 SchedulerEngine 的 setInterval', () => {
        const ms = numberFrom(read('src/main/scheduler/SchedulerEngine.ts'),
            /setInterval\(\(\)\s*=>\s*this\.tick\(\),\s*(\d+)\)/, '引擎轮询间隔')
        expect(ms).toBeGreaterThan(0)
        expect(ms % 1000).toBe(0)
        const sec = ms / 1000
        expect(doc()).toContain(`引擎${sec === 1 ? '每秒' : `每 ${sec} 秒`}轮询一次`)
    })

    it('脚本输出缓冲上限：文档「受 NMB 缓冲上限约束」取自 runScript 的输出上限常量', () => {
        const src = read('src/main/scheduler/index.ts')
        const mb = numberFrom(src, /const MAX_OUTPUT = (\d+)\s*\*\s*1024\s*\*\s*1024/, '脚本输出缓冲上限')
        expect(mb).toBeGreaterThan(0)
        expect(doc()).toContain(`受 ${mb}MB 缓冲上限约束`)
    })

    it('日志显示上限：文档「超过 N 万字符只显示前 N 万字符」取自 CONTENT_LIMIT', () => {
        const n = numberFrom(read('src/renderer/components/dialogs/ScheduleScriptLogPanel.tsx'),
            /const CONTENT_LIMIT = ([\d_]+)/, 'CONTENT_LIMIT')
        expect(n).toBeGreaterThan(0)
        const label = n % 10_000 === 0 ? `${n / 10_000} 万` : String(n)
        expect(doc()).toContain(`超过 ${label}字符只显示前 ${label}字符`)
    })

    it('断言不是恒真：同一条文档片段在数字被改坏时确实不匹配（反例自查）', () => {
        const ms = numberFrom(read('src/main/scheduler/index.ts'),
            /this\.restartTimer = setTimeout\([\s\S]*?\},\s*(\d+)\)/, 'worker 重建延迟')
        // 复核实测的坏法：把「约 5 秒」改成「约 4 小时」
        expect('应用会在约 4 小时后自动把它重新建起来').not.toContain(`约 ${ms / 1000} 秒后自动把它重新建起来`)
    })
})

describe('core-10 守卫（规则 8）— 反引号 token 内的字符串字面量必须真实存在', () => {
    it('token 里被引号包住的片段必须能在源码代码区里找到同名字面量', () => {
        const offenders: string[] = []
        for (const file of MANAGED_SOURCES) {
            for (const token of quotedTokens(read(file))) {
                for (const m of token.matchAll(/'([^'\n]+)'|"([^"\n]+)"/g)) {
                    const inner = m[1] ?? m[2]
                    if (!isQuotedInSource(inner)) offenders.push(`${file} → \`${token}\` 里的 ${m[0]}`)
                }
            }
        }
        expect(offenders).toEqual([])
    })

    it('覆盖面非空：确实抽到了含引号片段的 token（否则本条空转）', () => {
        const withQuotes = MANAGED_SOURCES.flatMap(f => quotedTokens(read(f)))
            .filter(t => /'[^'\n]+'|"[^"\n]+"/.test(t))
        expect(withQuotes.length).toBeGreaterThanOrEqual(5)
    })

    it('判定不是恒真：构造一个不存在的字面量会被判红（反例自查）', () => {
        expect(isQuotedInSource('no-such-literal-anywhere-xyz')).toBe(false)
        expect(isQuotedInSource('failure')).toBe(true)
    })
})
