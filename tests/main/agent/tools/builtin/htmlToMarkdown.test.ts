/**
 * htmlToMarkdown 单元测试
 *
 * 覆盖：
 * - 结构化标签转换（标题/列表/代码块/链接/表格）
 * - 不可见内容剔除（script/style/noscript/hidden/aria-hidden/display:none）
 * - 深度守卫（超过 512 层整体省略）
 * - 正文提取（article 优先 + 过短回退全文）
 * - 输入/输出截断标记
 *
 * 说明：全部走真实 turndown 转换，不做 mock。
 */
import {describe, expect, it} from 'vitest'
import {htmlToMarkdown} from '@/main/agent/tools/builtin/htmlToMarkdown'

describe('htmlToMarkdown — 结构化转换', () => {
  it('标题/列表/代码块/链接均正确转换', () => {
    const html = [
      '<h1>标题</h1>',
      '<p>段落<a href="https://a.com">链接</a></p>',
      '<ul><li>一</li><li>二</li></ul>',
      '<pre><code>const a = 1</code></pre>',
    ].join('')

    const result = htmlToMarkdown(html)

    expect(result.omitted).toBe(false)
    expect(result.markdown).toContain('# 标题')
    expect(result.markdown).toContain('[链接](https://a.com)')
    expect(result.markdown).toMatch(/^-\s+一$/m)
    expect(result.markdown).toMatch(/^-\s+二$/m)
    expect(result.markdown).toMatch(/```[\s\S]*const a = 1[\s\S]*```/)
  })

  it('表格转换为 GFM 表格', () => {
    const html = '<table><tr><th>名称</th><th>值</th></tr><tr><td>a</td><td>1</td></tr></table>'

    const {markdown} = htmlToMarkdown(html)

    expect(markdown).toContain('| 名称')
    expect(markdown).toContain('| 值')
    expect(markdown).toMatch(/\|\s*-{3,}\s*\|/)
    expect(markdown).toContain('| a')
  })
})

describe('htmlToMarkdown — 不可见内容剔除', () => {
  it('script/style/noscript 内容不进入 markdown', () => {
    const html = [
      '<script>var secretValue = 1</script>',
      '<style>.secretValue{color:red}</style>',
      '<noscript>noscript-secretValue</noscript>',
      '<p>可见正文</p>',
    ].join('')

    const {markdown} = htmlToMarkdown(html)

    expect(markdown).not.toContain('secretValue')
    expect(markdown).toContain('可见正文')
  })

  it('hidden / aria-hidden / display:none / visibility:hidden 内容不进入 markdown', () => {
    const html = [
      '<div hidden>隐-hidden</div>',
      '<div aria-hidden="true">隐-aria</div>',
      '<div style="display:none">隐-display</div>',
      '<div style="visibility: hidden">隐-visibility</div>',
      '<input type="hidden" value="隐-input">',
      '<p>可见-正文</p>',
    ].join('')

    const {markdown} = htmlToMarkdown(html)

    expect(markdown).not.toContain('隐-')
    expect(markdown).toContain('可见-正文')
  })
})

describe('htmlToMarkdown — 深度守卫', () => {
  it('嵌套深度超过 512 层 → 整体省略且不调用转换', () => {
    const html = '<div>'.repeat(600) + '深层内容' + '</div>'.repeat(600)

    const result = htmlToMarkdown(html)

    expect(result.omitted).toBe(true)
    expect(result.markdown).toBe('')
  })

  it('嵌套深度在阈值内 → 正常转换', () => {
    const html = '<div>'.repeat(100) + '浅层内容' + '</div>'.repeat(100)

    const result = htmlToMarkdown(html)

    expect(result.omitted).toBe(false)
    expect(result.markdown).toContain('浅层内容')
  })
})

describe('htmlToMarkdown — 正文提取', () => {
  it('存在 article 时剔除 nav/footer 噪音，只留正文', () => {
    const articleText = '正文段落内容。'.repeat(50)
    const navText = '导航链接文字'.repeat(30)
    const html = [
      '<html><body>',
      `<nav><a href="/">首页</a>${navText}</nav>`,
      `<article><p>${articleText}</p></article>`,
      '<footer>版权所有问题反馈联系方式</footer>',
      '</body></html>',
    ].join('')

    const {markdown} = htmlToMarkdown(html)

    expect(markdown).toContain('正文段落内容。')
    expect(markdown).not.toContain('导航链接文字')
    expect(markdown).not.toContain('版权所有')
  })

  it('正文过短（< 200 字符）→ 回退使用全文', () => {
    const longText = '长内容片段。'.repeat(100)
    const html = [
      '<html><body>',
      '<article><p>短正文</p></article>',
      `<div><p>${longText}</p></div>`,
      '</body></html>',
    ].join('')

    const {markdown} = htmlToMarkdown(html)

    expect(markdown).toContain('短正文')
    expect(markdown).toContain('长内容片段。')
  })
})

describe('htmlToMarkdown — 截断标记', () => {
  it('输入超过 maxInputChars → sourceTruncated 为 true', () => {
    const html = `<p>${'x'.repeat(1000)}</p>`

    const result = htmlToMarkdown(html, {maxInputChars: 100})

    expect(result.sourceTruncated).toBe(true)
    expect(result.omitted).toBe(false)
  })

  it('输出超过 maxOutputChars → markdown 被截到上限且 sourceTruncated 为 false', () => {
    const html = `<p>${'y'.repeat(1000)}</p>`

    const result = htmlToMarkdown(html, {maxOutputChars: 50})

    expect(result.markdown.length).toBeLessThanOrEqual(50)
    expect(result.sourceTruncated).toBe(false)
  })
})

describe('htmlToMarkdown — 深度守卫与隐式闭合', () => {
  it('600 个省略闭合的 <p> → 不省略且保留原文', () => {
    // HTML5 允许省略 </p>：若按未配对开标签计数，正常长文页会虚增深度被整页丢弃
    const html = '<p>段落文字。'.repeat(600)

    const result = htmlToMarkdown(html)

    expect(result.omitted).toBe(false)
    expect(result.markdown).toContain('段落文字。')
  })

  it('600 个省略闭合的 <li> → 不省略', () => {
    const html = '<li>列表项。'.repeat(600)

    const result = htmlToMarkdown(html)

    expect(result.omitted).toBe(false)
    expect(result.markdown).toContain('列表项。')
  })

  it('600 个未闭合 <div> → 仍然省略', () => {
    const html = '<div>'.repeat(600)

    const result = htmlToMarkdown(html)

    expect(result.omitted).toBe(true)
    expect(result.markdown).toBe('')
  })

  it('600 层真实嵌套 <div>…</div> → 仍然省略', () => {
    const html = '<div>'.repeat(600) + 'x' + '</div>'.repeat(600)

    const result = htmlToMarkdown(html)

    expect(result.omitted).toBe(true)
    expect(result.markdown).toBe('')
  })
})

describe('htmlToMarkdown — 正文提取的 class/id 语义过滤', () => {
  it('正文 class="content" 与更长的评论 class="comments" 并存 → 只取正文', () => {
    const articleText = '正文内容。'.repeat(51) // 255 字符
    const commentText = '评论噪音。'.repeat(180) // 900 字符，比正文更长

    const html = [
      '<html><body>',
      `<div class="content"><p>${articleText}</p></div>`,
      `<div class="comments"><p>${commentText}</p></div>`,
      '</body></html>',
    ].join('')

    const {markdown} = htmlToMarkdown(html)

    expect(markdown).toContain('正文内容。')
    expect(markdown).not.toContain('评论噪音。')
  })

  it('class/id 无任何语义信息且命中块过短 → 回退全文（不丢内容）', () => {
    const longText = '长内容片段。'.repeat(100)

    const html = [
      '<html><body>',
      '<div><p>短正文</p></div>',
      `<div><p>${longText}</p></div>`,
      '</body></html>',
    ].join('')

    const {markdown} = htmlToMarkdown(html)

    expect(markdown).toContain('短正文')
    expect(markdown).toContain('长内容片段。')
  })

  it('class="ad-banner" 与 class="header" 容器被排除，只留 class="content" 正文', () => {
    const adText = '广告推广文字。'.repeat(40)
    const headerText = '导航菜单条目。'.repeat(40)
    const articleText = '正文段落内容。'.repeat(40)

    const html = [
      '<html><body>',
      `<div class="ad-banner"><p>${adText}</p></div>`,
      `<div class="header"><p>${headerText}</p></div>`,
      `<div class="content"><p>${articleText}</p></div>`,
      '</body></html>',
    ].join('')

    const {markdown} = htmlToMarkdown(html)

    expect(markdown).toContain('正文段落内容。')
    expect(markdown).not.toContain('广告推广文字。')
    expect(markdown).not.toContain('导航菜单条目。')
  })

  it('语义 token 按非字母数字切分精确匹配：class="content-read" 不被 ad 子串误伤', () => {
    const noiseText = '侧栏噪音内容。'.repeat(60)
    const articleText = '正文段落内容。'.repeat(60)

    const html = [
      '<html><body>',
      `<div class="sidebar-read"><p>${noiseText}</p></div>`,
      `<div class="content-read"><p>${articleText}</p></div>`,
      '</body></html>',
    ].join('')

    const {markdown} = htmlToMarkdown(html)

    expect(markdown).toContain('正文段落内容。')
    expect(markdown).not.toContain('侧栏噪音内容。')
  })
})

describe('htmlToMarkdown — 表格规则', () => {
  it('表头单元格 align 映射为左/右/居中标记', () => {
    const html = [
      '<table><thead><tr>',
      '<th align="left">左</th><th align="right">右</th><th align="center">中</th>',
      '</tr></thead>',
      '<tbody><tr><td>1</td><td>2</td><td>3</td></tr></tbody>',
      '</table>',
    ].join('')

    const {markdown} = htmlToMarkdown(html)

    const lines = markdown.split('\n').map((line) => line.trim()).filter((line) => line.length > 0)
    expect(lines[0]).toMatch(/^\|\s*左\s*\|\s*右\s*\|\s*中\s*\|$/)
    expect(lines[1]).toMatch(/^\|\s*:---\s*\|\s*---:\s*\|\s*:---:\s*\|$/)
    expect(lines[2]).toMatch(/^\|\s*1\s*\|\s*2\s*\|\s*3\s*\|$/)
  })

  it('无表头表格不伪造空表头行', () => {
    const html = '<table><tbody><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></tbody></table>'

    const {markdown} = htmlToMarkdown(html)

    expect(markdown).toContain('| a')
    expect(markdown).toContain('| c')
    // 不得出现凭空生成的对齐标记行
    expect(markdown).not.toMatch(/\|\s*-{3,}\s*\|/)
  })

  it('单元格内容中的管道符转义为 \\|', () => {
    const html = '<table><tbody><tr><td>a|b</td><td>c</td></tr></tbody></table>'

    const {markdown} = htmlToMarkdown(html)

    expect(markdown).toContain('a\\|b')
  })

  it('删除线与任务列表仍按 GFM 输出（表格之外的能力未丢失）', () => {
    const html = '<p><del>删</del></p><ul><li><input type="checkbox" checked>已完成</li></ul>'

    const {markdown} = htmlToMarkdown(html)

    expect(markdown).toContain('~~删~~')
    expect(markdown).toMatch(/-\s+\[x\]\s+已完成/)
  })

  it('12000 行表格转换耗时低于 2000ms（防止退化为 O(行²)）', () => {
    const html = '<table>' + '<tr><td>x</td></tr>'.repeat(12000) + '</table>'

    const startedAt = Date.now()
    const {markdown} = htmlToMarkdown(html, {maxInputChars: 1_000_000})
    const elapsed = Date.now() - startedAt

    expect(markdown).toContain('| x')
    expect(elapsed).toBeLessThan(2000)
  }, 120_000)
})
