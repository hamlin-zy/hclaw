import {describe, it, expect} from 'vitest'
import {
    resolveToolName,
    parseToolSpec,
    TOOL_NAME_ALIASES,
    normalizeToolKey,
    findToolNameHint,
} from '../../../../src/main/agent/tools/toolNameResolver'

describe('resolveToolName', () => {
    it('精确匹配 HClaw 原生工具名', () => {
        expect(resolveToolName('file_read', ['file_read', 'file_write'])).toBe('file_read')
        expect(resolveToolName('glob', ['glob', 'grep'])).toBe('glob')
    })

    it('精确匹配优先于别名（原生名不得被覆盖）', () => {
        // 注册了字面量 `read` 工具时，精确匹配胜出，别名不生效
        expect(resolveToolName('read', ['read', 'file_read'])).toBe('read')
    })

    it('别名表：read → file_read', () => {
        expect(resolveToolName('read', ['file_read', 'file_write'])).toBe('file_read')
    })

    it('别名表：write → file_write', () => {
        expect(resolveToolName('write', ['file_read', 'file_write'])).toBe('file_write')
    })

    it('别名表：edit → file_edit', () => {
        expect(resolveToolName('edit', ['file_read', 'file_edit'])).toBe('file_edit')
    })

    it('别名表：NotebookEdit → notebook_edit（大小写不敏感）', () => {
        expect(resolveToolName('NotebookEdit', ['notebook_edit'])).toBe('notebook_edit')
    })

    it('别名表：TodoWrite/TodoRead/TodoUpdate → task_*（agent.md 兼容）', () => {
        expect(resolveToolName('TodoWrite', ['task_create'])).toBe('task_create')
        expect(resolveToolName('TodoRead', ['task_list'])).toBe('task_list')
        expect(resolveToolName('TodoUpdate', ['task_update'])).toBe('task_update')
    })

    it('别名表：Task → agent（Claude Code 子代理派发语义）', () => {
        expect(resolveToolName('Task', ['agent'])).toBe('agent')
    })

    // ── 新增：跨平台「动词_名词」命名 ──
    it('别名表：read_file / write_file / str_replace / apply_patch → 文件三件套', () => {
        const names = ['file_read', 'file_write', 'file_edit']
        expect(resolveToolName('read_file', names)).toBe('file_read')
        expect(resolveToolName('write_file', names)).toBe('file_write')
        expect(resolveToolName('str_replace', names)).toBe('file_edit')
        expect(resolveToolName('str_replace_editor', names)).toBe('file_edit')
        expect(resolveToolName('apply_patch', names)).toBe('file_edit')
        expect(resolveToolName('cat', names)).toBe('file_read')
    })

    it('别名表：shell / run_command / exec → bash', () => {
        expect(resolveToolName('shell', ['bash'])).toBe('bash')
        expect(resolveToolName('run_command', ['bash'])).toBe('bash')
        expect(resolveToolName('exec', ['bash'])).toBe('bash')
    })

    it('别名表：search_files / ripgrep → grep，find_files / list_files → glob', () => {
        expect(resolveToolName('search_files', ['grep', 'glob'])).toBe('grep')
        expect(resolveToolName('ripgrep', ['grep', 'glob'])).toBe('grep')
        expect(resolveToolName('find_files', ['grep', 'glob'])).toBe('glob')
        expect(resolveToolName('list_files', ['grep', 'glob'])).toBe('glob')
    })

    // ── 归一化同名层：同工具的写法差异无需列条目 ──
    it('归一化同名：fileRead / File-Read / READ 的 file_read 变体自动命中', () => {
        expect(resolveToolName('fileRead', ['file_read'])).toBe('file_read')
        expect(resolveToolName('File-Read', ['file_read'])).toBe('file_read')
        expect(resolveToolName('file read', ['file_read'])).toBe('file_read')
        expect(resolveToolName('READ', ['file_read'])).toBe('file_read')
    })

    // ── 失败关闭：歧义 ──
    it('歧义时拒绝解析：注册了字面量 Read 且存在 read→file_read 别名', () => {
        // 候选 = {file_read（别名）, Read（归一化同名）} → size 2 → undefined
        expect(resolveToolName('read', ['file_read', 'Read'])).toBeUndefined()
    })

    it('歧义时拒绝解析：两个已注册工具归一化后同名', () => {
        expect(resolveToolName('mytool', ['my_tool', 'my-tool'])).toBeUndefined()
    })

    // ── 失败关闭：语义漂移的名字故意不收录 ──
    it('create_file 不映射（语义＝不存在才建，与 file_write 无条件覆盖不等价）', () => {
        expect(resolveToolName('create_file', ['file_write', 'file_edit'])).toBeUndefined()
        expect(resolveToolName('append_file', ['file_write'])).toBeUndefined()
    })

    it('ls / list_dir 不映射（无对应内置工具）', () => {
        expect(resolveToolName('ls', ['glob', 'grep'])).toBeUndefined()
        expect(resolveToolName('list_dir', ['glob', 'grep'])).toBeUndefined()
    })

    it('search 不映射（无法唯一确定 grep 还是 glob）', () => {
        expect(resolveToolName('search', ['grep', 'glob'])).toBeUndefined()
    })

    it('别名目标不存在时返回 undefined', () => {
        expect(resolveToolName('write', ['file_read'])).toBeUndefined()
    })

    it('未知名（TaskWrite）返回 undefined', () => {
        expect(resolveToolName('TaskWrite', ['file_write'])).toBeUndefined()
    })

    it('不存在的工具名返回 undefined', () => {
        expect(resolveToolName('nonexistent', ['file_read'])).toBeUndefined()
    })
})

describe('normalizeToolKey', () => {
    it('小写 + 去分隔符（机械等价，无语义猜测）', () => {
        expect(normalizeToolKey('read_file')).toBe('readfile')
        expect(normalizeToolKey('readFile')).toBe('readfile')
        expect(normalizeToolKey('Read File')).toBe('readfile')
        expect(normalizeToolKey('READ-FILE')).toBe('readfile')
        expect(normalizeToolKey('Select-String')).toBe('selectstring')
    })
})

describe('findToolNameHint', () => {
    it('前缀命中给出候选', () => {
        expect(findToolNameHint('file_read_extra', ['file_read'])).toBe('file_read')
    })

    it('编辑距离命中给出候选', () => {
        expect(findToolNameHint('bashh', ['bash', 'grep'])).toBe('bash')
        expect(findToolNameHint('file_raed', ['file_read'])).toBe('file_read')
    })

    it('差距过大时不给建议', () => {
        expect(findToolNameHint('completely_unrelated', ['bash', 'grep'])).toBeUndefined()
    })
})

describe('parseToolSpec', () => {
    it('解析 rule', () => {
        expect(parseToolSpec('bash:always')).toEqual({toolName: 'bash', rule: 'always'})
    })

    it('无 rule', () => {
        expect(parseToolSpec('file_read')).toEqual({toolName: 'file_read', rule: undefined})
    })

    it('多个冒号仅取第一个', () => {
        expect(parseToolSpec('a:b:c')).toEqual({toolName: 'a', rule: 'b'})
    })
})

describe('TOOL_NAME_ALIASES', () => {
    it('包含 notebookedit 映射（回归：修复前缺失）', () => {
        expect(TOOL_NAME_ALIASES['notebookedit']).toBe('notebook_edit')
    })

    it('所有 key 必须是归一化形式（resolveToolName 以 normalizeToolKey 查表）', () => {
        for (const key of Object.keys(TOOL_NAME_ALIASES)) {
            expect(key, `别名 key "${key}" 未归一化`).toBe(normalizeToolKey(key))
        }
    })

    it('归一化后不得有重复 key（否则查表结果依赖对象键序）', () => {
        const seen = new Set<string>()
        for (const key of Object.keys(TOOL_NAME_ALIASES)) {
            const n = normalizeToolKey(key)
            expect(seen.has(n), `别名 key 归一化冲突: ${n}`).toBe(false)
            seen.add(n)
        }
    })
})
