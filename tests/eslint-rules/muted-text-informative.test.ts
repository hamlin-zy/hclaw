import { RuleTester } from 'eslint'
import tsparser from '@typescript-eslint/parser'
import rule from '../../eslint-rules/muted-text-informative'

const tester = new RuleTester({
    languageOptions: {
        parser: tsparser,
        parserOptions: { ecmaVersion: 'latest', sourceType: 'module', ecmaFeatures: { jsx: true } },
    },
})

tester.run('muted-text/informative', rule, {
    valid: [
        // 无小字号 → 不在信息性小字范围内
        { code: `const a = <div className="text-[var(--text-muted)]" />` },
        // 图标槽豁免：同时有 w-/h-
        { code: `const a = <div className="text-[var(--text-muted)] text-xs w-4 h-4" />` },
        // 图标槽豁免：shrink-0
        { code: `const a = <div className="text-[var(--text-muted)] text-xs shrink-0" />` },
        // 已迁移到 secondary
        { code: `const a = <div className="text-[var(--text-secondary)] text-xs" />` },
    ],
    invalid: [
        {
            code: `const a = <div className="text-[var(--text-muted)] text-xs" />`,
            errors: [{ messageId: 'informative' }],
        },
        {
            code: `const a = <div className={"text-[var(--text-muted)] text-sm"} />`,
            errors: [{ messageId: 'informative' }],
        },
    ],
})
