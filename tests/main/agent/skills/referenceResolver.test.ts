/**
 * referenceResolver 单元测试
 *
 * 覆盖：
 * - extractReferences / extractScriptCalls / parseScriptArgs：纯函数解析
 * - resolveReferencePath / resolveScriptPath：真实 fs 临时目录
 * - loadReferenceContent / getReferenceInfo：真实 fs 临时目录
 * - validateReferences / referenceExists / listReferences：真实 fs 临时目录
 *
 * 说明：
 * - 真实 fs 用例使用 mkdtemp + afterEach 清理（与 encodingGuard.test.ts 风格一致）。
 * - 测试过程中修复了两个 spec 违规的缺陷：① generateToc 标题正则未使用命名捕获组，
 *   导致标题 ≥2 时抛 TypeError；② REF_PATTERN_PLAIN 未排除反引号内的引用，导致
 *   `references/guide.md#L42` 被重复解析出无行号的副本。对应实现已在源文件修复。
 * - 测试内容中的命令仅作为文本样本出现，不含任何实际执行动作。
 */
import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import {
  extractReferences,
  extractScriptCalls,
  formatReferenceList,
  getReferenceInfo,
  listReferences,
  loadReferenceContent,
  parseScriptArgs,
  referenceExists,
  resolveReferencePath,
  resolveScriptPath,
  validateReferences,
} from '@/main/agent/skills/referenceResolver'

// ─── extractReferences（纯函数）──────────────────────────

describe('referenceResolver — extractReferences', () => {
  it('提取反引号引用', () => {
    expect(extractReferences('详见 `references/guide.md` 与 `references/faq.md`')).toEqual([
      {path: 'guide.md', loaded: false},
      {path: 'faq.md', loaded: false},
    ])
  })

  it('提取纯文本引用', () => {
    expect(extractReferences('更多信息见 references/api.md 文档')).toEqual([
      {path: 'api.md', loaded: false},
    ])
  })

  it('混合多种引用全部提取', () => {
    const content = [
      '先读 `references/overview.md`，',
      '然后看 references/quickstart.md，',
      '最后参考 `references/troubleshoot.md`。',
    ].join('')
    // 解析顺序：先反引号（overview、troubleshoot），后纯文本（quickstart）
    expect(extractReferences(content)).toEqual([
      {path: 'overview.md', loaded: false},
      {path: 'troubleshoot.md', loaded: false},
      {path: 'quickstart.md', loaded: false},
    ])
  })

  it('同一引用出现两次只返回一条（去重）', () => {
    const content = '见 `references/guide.md` 和 `references/guide.md`'
    expect(extractReferences(content)).toEqual([{path: 'guide.md', loaded: false}])
  })

  it('#L 行号引用解析出 line 字段', () => {
    expect(extractReferences('见 `references/guide.md#L42`')).toEqual([
      {path: 'guide.md', line: 42, loaded: false},
    ])
  })

  it('无引用返回空数组', () => {
    expect(extractReferences('这里没有任何引用')).toEqual([])
  })
})

// ─── extractScriptCalls（纯函数）────────────────────────

describe('referenceResolver — extractScriptCalls', () => {
  it('$ node 调用提取脚本与参数', () => {
    expect(extractScriptCalls('$ node ./scripts/process.js \'{"key":"value"}\'')).toEqual([
      {script: 'process.js', args: '{"key":"value"}', raw: '$ node ./scripts/process.js \'{"key":"value"}\''},
    ])
  })

  it('$ python 调用提取脚本与参数（双引号剥掉）', () => {
    expect(extractScriptCalls('$ python ./scripts/run.py "arg1"')).toEqual([
      {script: 'run.py', args: 'arg1', raw: '$ python ./scripts/run.py "arg1"'},
    ])
  })

  it('$ ./scripts/xxx.sh 调用提取脚本', () => {
    expect(extractScriptCalls('$ ./scripts/deploy.sh')).toEqual([
      {script: 'deploy.sh', args: '', raw: '$ ./scripts/deploy.sh'},
    ])
  })

  it('行首 ./scripts/xxx.sh 调用提取脚本', () => {
    expect(extractScriptCalls('./scripts/init.sh')).toEqual([
      {script: 'init.sh', args: '', raw: './scripts/init.sh'},
    ])
  })

  it('非支持扩展名（.txt/.md）不提取', () => {
    expect(extractScriptCalls('$ node ./scripts/notes.txt\n$ bash ./scripts/README.md')).toEqual([])
  })

  it('同一脚本出现多次只返回一条（去重）', () => {
    const content = '$ ./scripts/deploy.sh\n$ bash ./scripts/deploy.sh'
    expect(extractScriptCalls(content)).toEqual([
      {script: 'deploy.sh', args: '', raw: '$ ./scripts/deploy.sh'},
    ])
  })
})

// ─── parseScriptArgs（纯函数）──────────────────────────

describe('referenceResolver — parseScriptArgs', () => {
  it('JSON 对象解析', () => {
    expect(parseScriptArgs('{"key":"value","n":1}')).toEqual({key: 'value', n: 1})
  })

  it('单引号包裹的 JSON 剥引号后解析', () => {
    expect(parseScriptArgs('\'{"mode":"fast"}\'')).toEqual({mode: 'fast'})
  })

  it('双引号包裹的 JSON 剥引号后解析', () => {
    expect(parseScriptArgs('"{"mode":"fast"}"')).toEqual({mode: 'fast'})
  })

  it('非法 JSON 回退为 {input: 原始串}', () => {
    expect(parseScriptArgs('not-json')).toEqual({input: 'not-json'})
  })

  it('空串返回空对象', () => {
    expect(parseScriptArgs('')).toEqual({})
  })
})

// ─── 真实 fs 临时目录共享夹具 ──────────────────────────

describe('referenceResolver — 真实文件系统', () => {
  let skillDir: string

  beforeEach(async () => {
    skillDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ref-resolver-'))
  })

  afterEach(async () => {
    await fs.rm(skillDir, {recursive: true, force: true})
  })

  const writeRef = async (relPath: string, content: string): Promise<string> => {
    const full = path.join(skillDir, 'references', relPath)
    await fs.mkdir(path.dirname(full), {recursive: true})
    await fs.writeFile(full, content, 'utf8')
    return full
  }

  // ─── resolveReferencePath ─────────────────────────────

  describe('resolveReferencePath', () => {
    it('references/ 下存在 → 返回完整路径', async () => {
      const full = await writeRef('guide.md', '# Guide\nhello')
      expect(resolveReferencePath(skillDir, 'guide.md')).toBe(full)
    })

    it('根目录下存在（无 references 子目录）→ 返回完整路径', async () => {
      const full = path.join(skillDir, 'root-doc.md')
      await fs.writeFile(full, 'root doc', 'utf8')
      expect(resolveReferencePath(skillDir, 'root-doc.md')).toBe(full)
    })

    it('自动补 .md：refSpec 无后缀但文件是 .md → 命中', async () => {
      const full = await writeRef('guide.md', '# Guide')
      expect(resolveReferencePath(skillDir, 'guide')).toBe(full)
    })

    it('文件不存在 → null', () => {
      expect(resolveReferencePath(skillDir, 'missing.md')).toBeNull()
    })

    it('路径穿越（../escape.md）→ null', () => {
      expect(resolveReferencePath(skillDir, '../escape.md')).toBeNull()
    })

    it('绝对路径 → null', () => {
      expect(resolveReferencePath(skillDir, 'C:\\absolute.md')).toBeNull()
      expect(resolveReferencePath(skillDir, '/etc/passwd')).toBeNull()
    })
  })

  // ─── resolveScriptPath ────────────────────────────────

  describe('resolveScriptPath', () => {
    it('scripts/ 下存在 → 返回完整路径', async () => {
      const full = path.join(skillDir, 'scripts', 'process.js')
      await fs.mkdir(path.dirname(full), {recursive: true})
      await fs.writeFile(full, '// script', 'utf8')
      expect(resolveScriptPath(skillDir, 'process.js')).toBe(full)
    })

    it('根目录下存在 → 返回完整路径', async () => {
      const full = path.join(skillDir, 'tool.sh')
      await fs.writeFile(full, '#!/bin/sh', 'utf8')
      expect(resolveScriptPath(skillDir, 'tool.sh')).toBe(full)
    })

    it('不存在 → null', () => {
      expect(resolveScriptPath(skillDir, 'nope.js')).toBeNull()
    })
  })

  // ─── loadReferenceContent ─────────────────────────────

  describe('loadReferenceContent', () => {
    it('文件不存在 → 抛出 Reference not found', () => {
      expect(() => loadReferenceContent(path.join(skillDir, 'nope.md'))).toThrow('Reference not found')
    })

    it('maxLines 截断 → 包含 showing first 提示', async () => {
      const full = await writeRef('long.md', Array.from({length: 20}, (_, i) => `line ${i + 1}`).join('\n'))
      const out = loadReferenceContent(full, {maxLines: 3})
      expect(out).toContain('showing first 3')
      expect(out).toContain('line 1')
      expect(out).toContain('line 3')
    })

    it('extractLine → 包含上下文行与省略标记', async () => {
      const full = await writeRef('doc.md', Array.from({length: 40}, (_, i) => `content ${i + 1}`).join('\n'))
      const out = loadReferenceContent(full, {extractLine: 10})
      expect(out).toContain('... (line')
      expect(out).toContain('content 10')
    })

    it('includeToc：标题数 ≥2 时生成 TOC', async () => {
      const full = await writeRef('multi.md', '# 标题一\nbody\n## 标题二\nbody')
      const out = loadReferenceContent(full, {includeToc: true})
      expect(out).toContain('## Table of Contents')
      expect(out).toContain('[标题一]')
      expect(out).toContain('[标题二]')
      expect(out).toContain('# 标题一')
    })

    it('includeToc：标题数 <2 不生成 TOC，返回全文', async () => {
      const full = await writeRef('single.md', '# 唯一标题\nbody text')
      const out = loadReferenceContent(full, {includeToc: true})
      expect(out).not.toContain('Table of Contents')
      expect(out).toContain('# 唯一标题')
    })

    it('普通读取返回全文', async () => {
      const full = await writeRef('plain.md', 'a\nb\nc')
      expect(loadReferenceContent(full)).toBe('a\nb\nc')
    })
  })

  // ─── getReferenceInfo ─────────────────────────────────

  describe('getReferenceInfo', () => {
    it('存在文件 → 返回 size/lines/description（首行非 --- 取标题）', async () => {
      const full = await writeRef('info.md', '# My Doc\nhello\nworld')
      const info = getReferenceInfo(full)
      expect(info).not.toBeNull()
      expect(info!.size).toBeGreaterThan(0)
      expect(info!.lines).toBe(3)
      expect(info!.description).toBe('My Doc')
    })

    it('首行为 --- 的 frontmatter 不取 description', async () => {
      const full = await writeRef('fm.md', '---\nname: x\n---\nbody')
      const info = getReferenceInfo(full)
      expect(info!.description).toBeUndefined()
    })

    it('文件不存在 → null', () => {
      expect(getReferenceInfo(path.join(skillDir, 'missing.md'))).toBeNull()
    })
  })

  // ─── validateReferences / referenceExists / listReferences ─

  describe('validateReferences / referenceExists / listReferences', () => {
    it('validateReferences 分类有效与无效引用', async () => {
      await writeRef('ok.md', 'ok')
      const result = validateReferences(skillDir, [
        {path: 'ok.md', loaded: false},
        {path: 'bad.md', loaded: false},
      ])
      expect(result.valid).toEqual([{path: 'ok.md', content: undefined, loaded: false}])
      expect(result.invalid).toEqual(['bad.md'])
    })

    it('referenceExists 真/假', async () => {
      await writeRef('exists.md', 'x')
      expect(referenceExists(skillDir, 'exists.md')).toBe(true)
      expect(referenceExists(skillDir, 'absent.md')).toBe(false)
    })

    it('listReferences 列出 references/ 下的 .md/.txt 文件', async () => {
      await writeRef('a.md', 'a')
      await writeRef('nested/b.md', 'b')
      await writeRef('notes.txt', 'c')
      const list = listReferences(skillDir).sort()
      // path.relative 在 Windows 下返回反斜杠分隔路径，用 path.join 构造期望值
      expect(list).toEqual(['a.md', path.join('nested', 'b.md'), 'notes.txt'])
    })

    it('listReferences 无 references 目录返回空数组', async () => {
      const bare = await fs.mkdtemp(path.join(os.tmpdir(), 'ref-empty-'))
      try {
        expect(listReferences(bare)).toEqual([])
      } finally {
        await fs.rm(bare, {recursive: true, force: true})
      }
    })
  })

  // ─── formatReferenceList ──────────────────────────────

  describe('formatReferenceList', () => {
    it('格式化引用列表（loaded 带 ✅，line 带行号）', () => {
      const out = formatReferenceList([
        {path: 'a.md', loaded: true},
        {path: 'b.md', line: 7, loaded: false},
      ])
      expect(out).toContain('### Available References')
      expect(out).toContain('✅ `a.md`')
      expect(out).toContain('📄 `b.md` (line 7)')
    })

    it('空列表返回空串', () => {
      expect(formatReferenceList([])).toBe('')
    })
  })
})
