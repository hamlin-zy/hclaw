import eslint from '@eslint/js'
import tseslint from '@typescript-eslint/eslint-plugin'
import tsparser from '@typescript-eslint/parser'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'
import dataNameUnique from './eslint-rules/data-name-unique'
import mutedTextInformative from './eslint-rules/muted-text-informative'

export default [
  // ── TypeScript files ──────────────────────────────────
  {
    files: [
      'src/**/*.ts',
      'src/**/*.tsx',
      'tests/**/*.ts',
      'tests/**/*.tsx',
      'eslint-rules/**/*.ts',
      'eslint.config.ts',
      // 根级工具配置（vitest*.ts 等）与工具脚本的类型声明文件，此前既不在 lint 也不在 tsc 覆盖内。
      '*.ts',
      '**/*.d.mts',
    ],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        sourceType: 'module',
        ecmaVersion: 'latest',
      },
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.es2021,
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
      'react-hooks': reactHooks,
      'data-name': { rules: { unique: dataNameUnique } },
      'muted-text': { rules: { informative: mutedTextInformative } },
    },
    rules: {
      // TypeScript ESLint recommended
      ...tseslint.configs.recommended.rules,

      'data-name/unique': 'error',

      // --text-muted 不得用于承载信息的小字（四主题均 < AA 4.5:1）。
      // 存量已迁移完毕（见 tmp/muted-text-audit.md），升为 error 成为真正的门禁：
      // 承载信息的小字（含任意 <=13px 字号）不得再用 --text-muted，确属装饰请加带理由的 disable。
      'muted-text/informative': 'error',

      // Override: no unused vars — allow `_` prefix
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],

      // Allow unused locals only if they have a `_` prefix
      'no-unused-vars': 'off',

      // React Hooks rules
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',

      // Warn on console.log usage (but allow console.warn/error for logger.ts itself)
      'no-console': ['warn', { allow: ['warn', 'error'] }],

      // Additional useful rules
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/consistent-type-imports': 'off',
      '@typescript-eslint/ban-ts-comment': [
        'error',
        { 'ts-expect-error': 'allow-with-description', 'ts-ignore': false },
      ],
    },
  },

  // ── JavaScript / configs (no types) ───────────────────
  // 覆盖工具链盲区：根级配置（tailwind/postcss/vite/.dependency-cruiser）与 scripts/**。
  // 注意：`*.js` 不匹配点号开头的文件（如 .dependency-cruiser.js），需显式列出。
  {
    files: [
      '*.js',
      '*.mjs',
      '*.cjs',
      'scripts/**/*.js',
      'scripts/**/*.mjs',
      'scripts/**/*.cjs',
      '.dependency-cruiser.js',
    ],
    languageOptions: {
      // scripts/** 与根级配置使用 console/process/module/require 等 Node 全局，
      // 不补 globals 会因 no-undef 报大量 error。
      globals: { ...globals.node, ...globals.es2021 },
    },
    ...eslint.configs.recommended,
  },

  // ── Vitest test files ─────────────────────────────────
  {
    files: ['tests/**/*.ts'],
    plugins: {
      '@typescript-eslint': tseslint,
      'react-hooks': reactHooks,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      'react-hooks/rules-of-hooks': 'off',
      'react-hooks/exhaustive-deps': 'off',
    },
  },
]
