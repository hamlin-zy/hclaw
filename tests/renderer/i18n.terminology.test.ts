import {describe, expect, it} from 'vitest'
import fs from 'fs'
import path from 'path'

/**
 * 术语守卫（spec §3.2 文案对照表）。
 *
 * 目的：把「工作目录 / 工作区」→「项目」的产品概念层改名钉成回归测试。
 * 该项目组管理（2026-09-17）之前，侧栏 / 抽屉 / 输入区 / 定时任务 / 渠道命令等处的
 * 用户可见文案混用「工作目录」；本任务收口后，这些文件（**注释除外**）不得再出现旧词。
 *
 * 口径（spec §3.1）：
 *  - §3.2 表内字符串必须全量替换；
 *  - 表外命中不计漏改，尤其**不改**：进入 LLM schema / 工具返回值的提示词、
 *    `ToolsDialog.tsx` 的前端硬编码工具描述预览、代码标识（`workspacePath` 等）、
 *    git 语义的「工作区」（如 PM 窗口「工作区干净」）、代码注释。
 *
 * 本测试以读源文件（参照 tests/main/conversationsDialog.load.test.ts）的方式运行，
 * node 环境，无 jsdom。
 */

function readSrc(file: string): string {
    return fs.readFileSync(path.resolve(process.cwd(), file), 'utf-8')
}

/**
 * 去掉注释后的源码（行级剥离：整行注释 + 行尾 `//` 注释）。
 *
 * 例外清单允许旧词留在**代码注释**里（代码标识 / JSDoc 不在 §3.2 表内），
 * 故「不得再出现旧词」的断言必须先剥离注释，否则会把合法的注释命中误判成回归。
 * 行级剥离对本仓足够：注释一律是整行 `//` / `/** *\/` 形态，无字符串内 `//` 夹带旧词
 * 的场景（URL 等 `//` 只会让断言更保守，不会误报）。
 */
function stripComments(src: string): string {
    return src
        .split('\n')
        .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .map(line => {
            const i = line.indexOf('//')
            return i >= 0 ? line.slice(0, i) : line
        })
        .join('\n')
}

/**
 * §3.2 表内必须替换的用户可见文案（含前序 Task 9 / Task 13 已落地的落点）。
 * 每项断言该文件（原样，含注释）含有所列新文案。
 */
const REQUIRED: Array<{file: string; mustContain: string[]}> = [
    {file: 'src/main/window.ts', mustContain: ['选择项目文件夹']},
    {file: 'src/renderer/components/InputArea.tsx', mustContain: ['请先选择项目和会话']},
    {file: 'src/renderer/components/InputToolbar.tsx', mustContain: ['请先选择项目和会话']},
    {file: 'src/renderer/components/ConversationSidebar.tsx', mustContain: ['选择项目或项目组']},
    {
        file: 'src/renderer/components/ProjectGroupDrawer.tsx',
        mustContain: ['项目列表', '添加项目', '搜索项目…', '无匹配项目', '移除项目', '创建项目组', '移出组'],
    },
    {file: 'src/renderer/components/dialogs/MCPEditCard.tsx', mustContain: ['项目目录']},
    {
        file: 'src/main/project-manager/fileSystem.ts',
        mustContain: ['路径超出项目目录', '不能删除项目根目录'],
    },
    {file: 'src/main/agent/tools/executor.ts', mustContain: ['此文件不在项目目录下']},
    {
        file: 'src/main/channel/CommandManager.ts',
        mustContain: ['/new <项目编号>', '/dir — 查看项目列表', '暂无可用项目'],
    },
    {
        file: 'src/main/channel/messageHandler.ts',
        mustContain: ['暂无可用项目', '请先在桌面端选择或创建项目后再创建会话'],
    },
    {file: 'src/main/scheduler/scheduleWorkspace.ts', mustContain: ['未设置项目', '项目不可用']},
    {file: 'src/main/scheduler/index.ts', mustContain: ['项目不可用']},
    {
        file: 'src/renderer/components/dialogs/ScheduleUtils.ts',
        mustContain: ['项目列表尚未就绪', '请选择项目', '项目已失效，请重新选择一个现存的项目'],
    },
    {
        file: 'src/renderer/components/dialogs/ScheduleEditModal.tsx',
        mustContain: ['未设置项目（必选）', '重试加载项目列表'],
    },
    {file: 'src/renderer/stores/conversationStore.ts', mustContain: ['新项目']},
]

/** 「不得再出现旧词」的扫描清单 = 本任务实际改过文案的文件（注释除外） */
const MUST_REPLACE_FILES = [
    'src/main/window.ts',
    'src/main/utils/openConversation.ts',
    'src/main/project-manager/fileSystem.ts',
    'src/main/project-manager/search.ts',
    'src/main/agent/tools/executor.ts',
    'src/main/channel/CommandManager.ts',
    'src/main/channel/messageHandler.ts',
    'src/main/scheduler/index.ts',
    'src/main/scheduler/scheduleWorkspace.ts',
    'src/renderer/components/InputArea.tsx',
    'src/renderer/components/InputToolbar.tsx',
    'src/renderer/components/ConversationSidebar.tsx',
    'src/renderer/components/ProjectGroupDrawer.tsx',
    'src/renderer/components/FilePicker.tsx',
    'src/renderer/components/MainWorkspace.tsx',
    'src/renderer/components/dialogs/MCPEditCard.tsx',
    'src/renderer/components/dialogs/ScheduleEditModal.tsx',
    'src/renderer/components/dialogs/ScheduleUtils.ts',
    'src/renderer/hooks/useScheduleFormState.ts',
    'src/renderer/stores/conversationStore.ts',
    'src/renderer/project-manager/ProjectManagerApp.tsx',
]

/** 旧词：产品概念层已统一为「项目」 */
const OLD_TERMS = ['工作目录', '工作区列表']

/**
 * 旧词（精确串）：「工作区」本身不能直接 ban —— `ProjectManagerApp.tsx` 的
 * 「工作区干净」是 **git 语义**（spec §3.1 例外 3，不得改），而该文件同在
 * `MUST_REPLACE_FILES` 内。故按**精确串**收口：逐个用户可见回退写法列黑名单。
 *
 * 其中若干串在当前源码里已不存在 —— 那是正常的**负向断言**（不存在即通过）；
 * 关键作用是：一旦有人把任一 UI 文案回退成裸「工作区」写法，本用例立即红。
 */
const OLD_TERMS_EXACT = [
    '请选择工作区',
    '切换工作区',
    '工作区：',
    '暂无可用工作区',
    '新工作区',
    '未设置工作区',
    '不能删除工作区根目录',
]

/** §3.1 例外：本任务不改，也不得判为漏改 */
const EXEMPT_FILES = [
    'src/renderer/components/dialogs/ToolsDialog.tsx',
    'src/main/agent/systemPrompt.ts',
    'src/main/agent/tools/builtin/memoTool.ts',
]

describe('术语替换（§3.2 表内项 → 新文案）', () => {
    for (const {file, mustContain} of REQUIRED) {
        for (const needle of mustContain) {
            it(`${file} 含「${needle}」`, () => {
                expect(readSrc(file)).toContain(needle)
            })
        }
    }
})

describe('旧词收口（MUST_REPLACE_FILES，注释除外）', () => {
    for (const file of MUST_REPLACE_FILES) {
        it(`${file} 不再出现「工作目录 / 工作区列表」`, () => {
            const src = stripComments(readSrc(file))
            for (const term of OLD_TERMS) {
                expect(src).not.toContain(term)
            }
        })

        it(`${file} 不再出现裸「工作区」回退写法`, () => {
            const src = stripComments(readSrc(file))
            for (const term of OLD_TERMS_EXACT) {
                expect(src).not.toContain(term)
            }
        })
    }
})

describe('§3.1 例外清单（不得判为漏改）', () => {
    it('ToolsDialog 的硬编码工具描述预览保留旧词（与 DB 工具 schema 同源）', () => {
        const src = readSrc('src/renderer/components/dialogs/ToolsDialog.tsx')
        expect(src).toContain('在用户的工作目录中执行 shell 命令')
    })

    it('例外文件不在「必须替换」清单内', () => {
        for (const f of EXEMPT_FILES) {
            expect(MUST_REPLACE_FILES).not.toContain(f)
            expect(REQUIRED.some(r => r.file === f)).toBe(false)
        }
    })
})
