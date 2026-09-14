import {describe, it, expect} from 'vitest'
import {fileIcon, fileKind, fileKindClass, KIND_SPEC, FOLDER_SPEC, FOLDER_OPEN_SPEC, ROOT_SPEC} from '../../../src/renderer/project-manager/lib/fileIcon'

describe('fileIcon §6.1 扩展名 → 图标 + 颜色令牌', () => {
  it.each([
    ['index.ts', 'code'], ['App.tsx', 'code'], ['main.js', 'code'], ['a.mjs', 'code'],
    ['b.cjs', 'code'], ['s.py', 'code'], ['m.go', 'code'], ['l.rs', 'code'], ['M.java', 'code'],
    ['a.css', 'style'], ['a.scss', 'style'], ['a.less', 'style'],
    ['README.md', 'markup'], ['a.mdx', 'markup'], ['a.txt', 'markup'], ['a.rst', 'markup'],
    ['package.json', 'data'], ['a.yaml', 'data'], ['a.yml', 'data'], ['a.toml', 'data'], ['a.xml', 'data'],
    ['a.png', 'image'], ['a.JPG', 'image'], ['a.jpeg', 'image'], ['a.gif', 'image'],
    ['a.webp', 'image'], ['a.svg', 'image'], ['a.bmp', 'image'],
    ['unknown.xyz', 'unknown'], ['noext', 'unknown'],
  ])('%s → %s', (name, kind) => {
    expect(fileIcon(name)).toBe(KIND_SPEC[kind as keyof typeof KIND_SPEC])
  })

  it.each([
    ['.gitignore'], ['.env'], ['.editorconfig'], ['.npmrc'],
  ])('点文件 %s 走配置类（按名字精确匹配，不靠扩展名）', name => {
    expect(fileIcon(name)).toBe(KIND_SPEC.config)
  })

  it('大小写不敏感', () => {
    expect(fileIcon('INDEX.TS')).toBe(KIND_SPEC.code)
    expect(fileIcon('.GITIGNORE')).toBe(KIND_SPEC.config)
  })

  it('颜色一律为令牌（编译期约束：不得出现 hex 字面值）', () => {
    for (const spec of [...Object.values(KIND_SPEC), FOLDER_SPEC, FOLDER_OPEN_SPEC, ROOT_SPEC]) {
      expect(spec.color).toMatch(/^var\(--[a-z-]+\)$/)
    }
  })

  it('根节点与展开目录用同一套文件夹图标（品牌色）', () => {
    expect(ROOT_SPEC.Icon).toBe(FOLDER_OPEN_SPEC.Icon)
    expect(FOLDER_SPEC.color).toBe('var(--icon-folder)')
  })

  it('每类图标互不相同（避免"所有文件一个样"）', () => {
    const icons = Object.values(KIND_SPEC).map(s => s.Icon)
    // unknown 与 config 故意共用 File / Settings 之外的不同图标：config=Settings, unknown=File
    expect(new Set(icons).size).toBe(icons.length)
  })
})

describe('fileKind：测试文件单独成类（IDEA 式绿色）', () => {
  it.each([
    ['Foo.test.tsx', 'test'], ['foo.test.ts', 'test'], ['a.spec.mjs', 'test'],
    ['b.SPEC.js', 'test'], ['c.test.cjs', 'test'],
  ])('%s → %s', (name, kind) => {
    expect(fileKind(name)).toBe(kind)
    expect(fileIcon(name)).toBe(KIND_SPEC.test)
  })

  it('中缀只对代码类生效，不误伤其它类别', () => {
    expect(fileKind('a.test.json')).toBe('data')
    expect(fileKind('README.test.md')).toBe('markup')
    expect(fileKind('main.ts')).toBe('code')
    expect(fileKind('styles.test.css')).toBe('style')
  })

  it('KIND_SPEC.test 用专属颜色令牌（不与他人共用）', () => {
    expect(KIND_SPEC.test.color).toBe('var(--ft-test)')
    expect(KIND_SPEC.code.color).toBe('var(--ft-code)')
  })
})

describe('fileKindClass：类型 → 文件名着色类', () => {
  it.each([
    ['a.ts', 'pm-ft--code'],
    ['a.test.ts', 'pm-ft--test'],
    ['a.css', 'pm-ft--style'],
    ['README.md', 'pm-ft--markup'],
    ['package.json', 'pm-ft--data'],
    ['a.png', 'pm-ft--image'],
  ])('%s → %s', (name, cls) => {
    expect(fileKindClass(name)).toBe(cls)
  })

  it('config / unknown 不着色（空串，文件名保持正文色）', () => {
    expect(fileKindClass('.gitignore')).toBe('')
    expect(fileKindClass('.env')).toBe('')
    expect(fileKindClass('noext')).toBe('')
    expect(fileKindClass('a.xyz')).toBe('')
  })
})
