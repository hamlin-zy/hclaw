import { RuleTester } from 'eslint'
import tsparser from '@typescript-eslint/parser'
import rule from '../../eslint-rules/data-name-unique'

const tester = new RuleTester({
  languageOptions: {
    parser: tsparser,
    parserOptions: { ecmaVersion: 'latest', sourceType: 'module', ecmaFeatures: { jsx: true } },
  },
})

tester.run('data-name/unique', rule, {
  valid: [
    { code: `const a = <div data-name="input-area-card" />` },
    { code: `const a = <div data-name={dynamicValue} />` }, // 非字面量不检查
  ],
  invalid: [
    {
      code: `const a = <div data-name="dup-card" />\nconst b = <button data-name="dup-card" />`,
      errors: [{ messageId: 'duplicate' }],
    },
    {
      code: `const a = <div data-name="Bad_Name" />`,
      errors: [{ messageId: 'badFormat' }],
    },
  ],
})
