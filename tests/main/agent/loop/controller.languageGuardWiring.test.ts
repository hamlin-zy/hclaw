/**
 * 语言守卫 controller 挂载点契约（spec §9-T7）
 *
 * 为什么是源码级断言：§3.2 的「只在 run 首次迭代注入」是**调用点**的属性 ——
 * turnCount 由 controller 的私有局部变量推进（LoopState.turnCount 从不更新，
 * createLoopState 置 0 后再无赋值），pre-step 内部无法观测。这里把「调用点存在 +
 * 被 isLanguageGuardIteration(turnCount) 守卫 + 顺序位于 memory 之后、构建 system 之前」
 * 钉死；行为语义由 languageGuardPublish.test.ts（谓词）与
 * languageGuard.integration.test.ts（T6 位置不变量）覆盖。
 *
 * 同款手法先例：tests/shared/settingsDefaults.test.ts（读源码断言引用关系）。
 *
 * 口径补充：**system 注入的装配点在 controller/setup**；languageGuardPublish 只提供
 * 文案与判定纯函数（user 版注入与 system 段判定同源，但都不碰 system 文本本身）。
 */
import {describe, it, expect} from 'vitest'
import {readFileSync} from 'fs'
import {resolve} from 'path'

const SOURCE = readFileSync(resolve(process.cwd(), 'src/main/agent/loop/controller.ts'), 'utf8')

describe('controller 语言守卫挂载（spec §9-T7）', () => {
    it('导入并调用三个新导出', () => {
        expect(SOURCE).toContain("from './languageGuardPublish'")
        expect(SOURCE).toContain('restoreLanguageGuardState(currentState.messages)')
        // 格式无关的子串断言：参数正确性由「结构级 if 块包裹」断言与顺序断言覆盖
        expect(SOURCE).toContain('runLanguageGuardPreStep(')
    })

    it('调用点被 turnCount === 1 门槛守卫（§3.2 硬约束）', () => {
        // 结构级断言：调用点必须**在 if 块内**（含实测缩进；若调用点被移出 if 块，
        // 门槛即失效，本断言必红）。不依赖"两个 indexOf 距离 < 400"的邻近启发式。
        expect(SOURCE).toContain(
            'if (isLanguageGuardIteration(turnCount)) {\n                const r = runLanguageGuardPreStep(')
    })

    it('pre-step 顺序 catalog → env → memory → languageGuard，且都在构建 system 之前', () => {
        const idx = {
            catalog: SOURCE.indexOf('runCatalogPreStep('),
            env: SOURCE.indexOf('runEnvPreStep('),
            memory: SOURCE.indexOf('runMemoryPreStep('),
            languageGuard: SOURCE.indexOf('runLanguageGuardPreStep('),
            // 代码锚点（全文件唯一）：真实调用点 await buildSystemPrompt( 本身，
            // 不再依赖「构建系统提示词」注释行（改注释不该判红）。
            buildSystem: SOURCE.indexOf('await buildSystemPrompt('),
        }
        for (const [name, value] of Object.entries(idx)) expect(value, name).toBeGreaterThan(-1)
        expect(idx.catalog).toBeLessThan(idx.env)
        expect(idx.env).toBeLessThan(idx.memory)
        expect(idx.memory).toBeLessThan(idx.languageGuard)
        expect(idx.languageGuard).toBeLessThan(idx.buildSystem)
    })

    it('状态声明在循环外（与三个兄弟 pre-step 同构）', () => {
        // 不耦合类型注解写法（去掉 ': LanguageGuardState' 也不该判红），拆两个短子串
        const declIdx = SOURCE.indexOf('let languageGuardState')
        const restoreIdx = SOURCE.indexOf('restoreLanguageGuardState(currentState.messages)')
        const loopIdx = SOURCE.indexOf('while (turnCount < maxTurnsLimit)')
        expect(declIdx).toBeGreaterThan(-1)
        expect(restoreIdx).toBeGreaterThan(-1)
        expect(loopIdx).toBeGreaterThan(-1)
        expect(declIdx).toBeLessThan(loopIdx)
    })

    /**
     * §3.1③「不动 system prompt」的结构级护栏（此前零护栏）：
     * languageGuardPublish 在结构上不得出现任何 system prompt 标识符 ——
     * 「永不落 system prompt」不能只靠注释承诺。
     */
    it('languageGuardPublish 结构性不触碰 system prompt（§3.1③）', () => {
        const PUBLISH_SRC = readFileSync(resolve(process.cwd(), 'src/main/agent/loop/languageGuardPublish.ts'), 'utf8')
        for (const ident of ['systemPrompt', 'setSystemPrompt', 'cachedSystemPrompt']) {
            expect(PUBLISH_SRC, ident).not.toContain(ident)
        }
    })

    /**
     * 子会话常驻语言段的装配点（brief §2.5）：判定结果在循环外算一次（run 内不可变），
     * 并且**必须同时**进入签名与构建入参 —— 只入其一都会让签名一致的旧缓存被错误复用。
     */
    it('子会话语言段在循环外计算并入签名（brief §2.5 / Fix 轮 2）', () => {
        // Fix 轮 2 · Fix-2：判定改用**会话身份**（落库真相 ConversationMeta.isChildSession）。
        // isSubagentRun 只覆盖 agentTool 内联派发；子会话再次激活走 worker 硬编码
        // traceContext:'main' 且无 modelRole → 仅凭运行身份会漏注入。
        // 短子串 + 结构化锚定（不耦合逐字长串）：函数被调用 → 实参落在**同一调用行**内。
        // 钉住"两条入口任一命中即注入"：运行身份（agentTool 内联派发）与会话落库身份
        // 都必须出现在实参中，且不再允许任一词只是散落在文件别处。
        const langCallIdx = SOURCE.indexOf('resolveSubagentLanguageSection(')
        expect(langCallIdx).toBeGreaterThan(-1)
        const langCallLine = SOURCE.slice(langCallIdx, SOURCE.indexOf('\n', langCallIdx))
        expect(langCallLine).toContain('isSubagentRun')
        expect(langCallLine).toContain('isChildSession')
        expect(langCallLine).toContain('getSettings()')
        // Fix 轮 2 · Fix-1：条件入键——无语言段时键集与历史格式逐字相同
        expect(SOURCE).toContain('languageSection ? {...base, languageSection} : base')
        // 代码锚点（全文件唯一）：真实调用点本身，不命中函数定义处
        const sigCallIdx = SOURCE.indexOf('const cacheSignature = buildSystemSignature(')
        const buildCallIdx = SOURCE.indexOf('await buildSystemPrompt(')
        expect(sigCallIdx).toBeGreaterThan(-1)
        // 签名调用块（到 buildSystemPrompt 调用点之间）内必须出现 languageSection 传参
        expect(SOURCE.slice(sigCallIdx, buildCallIdx)).toContain('languageSection,')
        // 顺序不变量：先算签名（含语言段）→ 再构建 system
        expect(sigCallIdx).toBeLessThan(buildCallIdx)
    })
})
