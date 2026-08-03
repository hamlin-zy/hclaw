/**
 * seedAgentFiles.ts 完整性校验测试
 *
 * 覆盖 isValidBuiltinAgentFile 的既有 8 用例 + Fix Round 1 新增用例（真实临时文件，非 mock）：
 *   1. 完整内置文件（frontmatter + source:hclaw 标记 + 非空正文）→ true
 *   2. 文件不存在 → false
 *   3. 空文件 → false
 *   4. 无 frontmatter → false
 *   5. 缺 source:hclaw 标记（用户自定义 Agent）→ false
 *   6. 正文为空 → false
 *   7. 正文仅空白 → false
 *   8. frontmatter 损坏（缺闭合 ---）→ false
 *
 * Fix Round 1 新增：
 *   - BOM 前缀 + 完整内置文件 → true
 *   - tags 子串误命中防护：tags: [custom, mysource:hclawzz] → false
 *   - `# source:hclaw` 注释行 + 无真实标记 → false
 *   - classifyBuiltinAgentFile 四状态：missing / valid / corrupt / user-conflict
 *   - seedDefaultAgentFiles 三分支：不存在→种子写入、损坏→重建覆盖、用户同名文件→不覆盖
 */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

// 隔离保证：seedAgentFiles → ../../config → repositories 存在循环依赖（_cachedHclawDir TDZ）。
// mock 掉 config 以切断链路，且 getHclawDir 指向临时目录，绝不触碰真实 ~/.hclaw。
// 注意：vi.mock 工厂被提升（hoist），路径必须在工厂内计算。
vi.mock('../../../../src/main/config', () => {
    const os = require('os')
    const path = require('path')
    const testDir = path.join(os.tmpdir(), 'hclaw-seed-test-' + Date.now())
    return {
        getHclawDir: () => testDir,
        isSafePath: (p: string) => p.startsWith(testDir),
        HCLAW_DIR: testDir,
    }
})

import {
    classifyBuiltinAgentFile,
    isValidBuiltinAgentFile,
    seedDefaultAgentFiles,
} from '../../../../src/main/agent/defaults/seedAgentFiles'
import {getHclawDir} from '../../../../src/main/config'

let tempDir: string

beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-agent-files-test-'))
})

afterEach(() => {
    fs.rmSync(tempDir, {recursive: true, force: true})
})

function writeTemp(content: string): string {
    const filePath = path.join(tempDir, 'test-agent.md')
    fs.writeFileSync(filePath, content, 'utf-8')
    return filePath
}

describe('isValidBuiltinAgentFile — 内置 Agent 文件完整性校验', () => {
    it('完整内置文件（frontmatter + source:hclaw + 非空正文）→ true', () => {
        const filePath = writeTemp(`---
name: Test Agent
description: 测试用内置 Agent
tags: [test, builtin, source:hclaw]
enabled: true
---

正文内容
`)
        expect(isValidBuiltinAgentFile(filePath)).toBe(true)
    })

    it('文件不存在 → false', () => {
        expect(isValidBuiltinAgentFile(path.join(tempDir, 'missing.md'))).toBe(false)
    })

    it('空文件 → false', () => {
        expect(isValidBuiltinAgentFile(writeTemp(''))).toBe(false)
    })

    it('无 frontmatter（直接正文）→ false', () => {
        expect(isValidBuiltinAgentFile(writeTemp('plain body without frontmatter'))).toBe(false)
    })

    it('缺 source:hclaw 标记（用户自定义 Agent）→ false', () => {
        const filePath = writeTemp(`---
name: My Custom Agent
description: 用户自定义 Agent
tags: [custom]
---

用户正文
`)
        expect(isValidBuiltinAgentFile(filePath)).toBe(false)
    })

    it('正文为空 → false', () => {
        const filePath = writeTemp(`---
name: Test Agent
tags: [source:hclaw]
---
`)
        expect(isValidBuiltinAgentFile(filePath)).toBe(false)
    })

    it('正文仅空白 → false', () => {
        const filePath = writeTemp(`---
name: Test Agent
tags: [source:hclaw]
---

   
`)
        expect(isValidBuiltinAgentFile(filePath)).toBe(false)
    })

    it('frontmatter 损坏（缺闭合 ---）→ false', () => {
        const filePath = writeTemp(`---
name: Test Agent
tags: [source:hclaw]

正文在未闭合 frontmatter 内
`)
        expect(isValidBuiltinAgentFile(filePath)).toBe(false)
    })
})

describe('isValidBuiltinAgentFile — Fix Round 1：BOM 与标记判定', () => {
    it('BOM 前缀 + 完整内置文件 → true', () => {
        const filePath = writeTemp(
            '\uFEFF' +
                `---
name: Test Agent
description: 测试用内置 Agent
tags: [test, builtin, source:hclaw]
enabled: true
---

正文内容
`,
        )
        expect(isValidBuiltinAgentFile(filePath)).toBe(true)
    })

    it('tags 子串误命中防护：tags: [custom, mysource:hclawzz] → false', () => {
        const filePath = writeTemp(`---
name: Test Agent
tags: [custom, mysource:hclawzz]
---

正文内容
`)
        expect(isValidBuiltinAgentFile(filePath)).toBe(false)
    })

    it('# source:hclaw 注释行 + 无真实标记 → false', () => {
        const filePath = writeTemp(`---
name: Test Agent
# source:hclaw
tags: [custom]
---

正文内容
`)
        expect(isValidBuiltinAgentFile(filePath)).toBe(false)
    })
})

describe('classifyBuiltinAgentFile — 四种状态分类', () => {
    it('文件不存在 → missing', () => {
        expect(classifyBuiltinAgentFile(path.join(tempDir, 'nope.md'))).toBe('missing')
    })

    it('完整内置文件 → valid', () => {
        const filePath = writeTemp(`---
name: Test Agent
tags: [test, builtin, source:hclaw]
---

正文内容
`)
        expect(classifyBuiltinAgentFile(filePath)).toBe('valid')
    })

    it('结构不完整（无 frontmatter）→ corrupt', () => {
        expect(classifyBuiltinAgentFile(writeTemp('plain body without frontmatter'))).toBe('corrupt')
    })

    it('结构完整但无内置标记 → user-conflict', () => {
        const filePath = writeTemp(`---
name: My Custom Agent
description: 用户自定义 Agent
tags: [custom]
---

用户正文
`)
        expect(classifyBuiltinAgentFile(filePath)).toBe('user-conflict')
    })
})

describe('seedDefaultAgentFiles — 种子写入 / 重建 / 用户同名不覆盖', () => {
    const agentsDir = path.join(getHclawDir(), 'agents')

    beforeEach(() => {
        fs.rmSync(agentsDir, {recursive: true, force: true})
    })

    it('文件不存在 → 正常种子写入', () => {
        seedDefaultAgentFiles()
        const dest = path.join(agentsDir, 'implementer.md')
        expect(fs.existsSync(dest)).toBe(true)
        expect(fs.readFileSync(dest, 'utf-8')).toContain('source:hclaw')
    })

    it('结构不完整（损坏）的内置文件 → 重建覆盖', () => {
        fs.mkdirSync(agentsDir, {recursive: true})
        const dest = path.join(agentsDir, 'implementer.md')
        fs.writeFileSync(dest, 'corrupt content without frontmatter', 'utf-8')
        seedDefaultAgentFiles()
        const after = fs.readFileSync(dest, 'utf-8')
        expect(after).toContain('source:hclaw')
        expect(after).not.toContain('corrupt content without frontmatter')
    })

    it('用户自定义文件占用内置文件名（结构完整但无标记）→ 不覆盖，仅跳过模板', () => {
        fs.mkdirSync(agentsDir, {recursive: true})
        const dest = path.join(agentsDir, 'implementer.md')
        const userContent = `---
name: My Custom Implementer
description: 用户自己的实现者，不应被内置模板覆盖
tags: [custom, user]
---

我的自定义正文
`
        fs.writeFileSync(dest, userContent, 'utf-8')
        seedDefaultAgentFiles()
        expect(fs.readFileSync(dest, 'utf-8')).toBe(userContent)
    })
})
