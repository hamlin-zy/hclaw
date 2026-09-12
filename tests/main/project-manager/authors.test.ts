import {describe, it, expect} from 'vitest'
import {mkdtempSync, writeFileSync, rmSync} from 'fs'
import {tmpdir} from 'os'
import {join} from 'path'
import {execFileSync} from 'child_process'
import {getGitAuthors, parseShortlog, MAX_AUTHOR_COUNT} from '../../../src/main/project-manager/git/authors'

// 真实临时仓库（沿用 gitExecResult.test.ts 的构造方式）：authors.ts 依赖 git 自身的
// shortlog 聚合与排序语义，mock 掉 git 就测不到解析与真实输出格式的契合度。
function makeRepo(): string {
  const ws = mkdtempSync(join(tmpdir(), 'pm-authors-'))
  execFileSync('git', ['init', '-q'], {cwd: ws, stdio: 'ignore'})
  return ws
}

let seq = 0
function commit(ws: string, name: string, email: string, message: string): void {
  writeFileSync(join(ws, 'a.txt'), `${seq++}`)
  execFileSync('git', ['add', 'a.txt'], {cwd: ws, stdio: 'ignore'})
  execFileSync('git', [
    '-c', `user.name=${name}`,
    '-c', `user.email=${email}`,
    'commit', '-q', '-m', message,
  ], {cwd: ws, stdio: 'ignore'})
}

describe('getGitAuthors（真实临时仓库）', () => {
  it('① 按提交数降序，其次作者名升序', async () => {
    const ws = makeRepo()
    try {
      commit(ws, 'Bob', 'bob@x.com', 'b1')
      commit(ws, 'Alice', 'alice@x.com', 'a1')
      commit(ws, 'Alice', 'alice@x.com', 'a2')
      commit(ws, 'Carol', 'carol@x.com', 'c1')
      const authors = await getGitAuthors(ws)
      expect(authors).toEqual([
        {name: 'Alice', email: 'alice@x.com', commits: 2},
        {name: 'Bob', email: 'bob@x.com', commits: 1},
        {name: 'Carol', email: 'carol@x.com', commits: 1},
      ])
    } finally { rmSync(ws, {recursive: true, force: true}) }
  })

  it('⑤ 同名不同 email 视为不同作者（分组键 = name + email）', async () => {
    const ws = makeRepo()
    try {
      commit(ws, 'Alice', 'alice@x.com', 'a1')
      commit(ws, 'Alice', 'alice2@x.com', 'a2')
      const authors = await getGitAuthors(ws)
      expect(authors).toHaveLength(2)
      expect(authors.map(a => a.email).sort()).toEqual(['alice2@x.com', 'alice@x.com'])
      expect(authors.find(a => a.email === 'alice@x.com')!.commits).toBe(1)
      expect(authors.find(a => a.email === 'alice2@x.com')!.name).toBe('Alice')
    } finally { rmSync(ws, {recursive: true, force: true}) }
  })

  it('branch 参数限定聚合范围；未传默认 HEAD', async () => {
    const ws = makeRepo()
    try {
      commit(ws, 'Alice', 'alice@x.com', 'a1')          // main 独有
      execFileSync('git', ['checkout', '-q', '-b', 'feature'], {cwd: ws, stdio: 'ignore'})
      commit(ws, 'Bob', 'bob@x.com', 'b1')              // feature 独有
      const onFeature = await getGitAuthors(ws, {branch: 'feature'})
      expect(onFeature.map(a => a.name)).toEqual(['Alice', 'Bob'])
      // HEAD 在 feature 上：不传 branch 与显式 HEAD 一致
      expect(await getGitAuthors(ws)).toEqual(onFeature)
      expect(await getGitAuthors(ws, {branch: 'HEAD'})).toEqual(onFeature)
    } finally { rmSync(ws, {recursive: true, force: true}) }
  })

  it('② 非法 branch（前导 -、空格、;、..）被拒，不触发 git', async () => {
    const ws = makeRepo()
    try {
      commit(ws, 'Alice', 'alice@x.com', 'a1')
      for (const bad of ['--inject', 'a b', 'main ; rm -rf /', '..', 'main..dev', '-x']) {
        await expect(getGitAuthors(ws, {branch: bad})).rejects.toThrow('无效的 git ref')
      }
    } finally { rmSync(ws, {recursive: true, force: true}) }
  })

  it('语法合法但不存在的 ref → 空数组（不抛）', async () => {
    const ws = makeRepo()
    try {
      commit(ws, 'Alice', 'alice@x.com', 'a1')
      await expect(getGitAuthors(ws, {branch: 'nope-nope'})).resolves.toEqual([])
    } finally { rmSync(ws, {recursive: true, force: true}) }
  })

  it('③ 空仓库（无 commit）返回空数组且不抛', async () => {
    const ws = makeRepo()
    try {
      await expect(getGitAuthors(ws)).resolves.toEqual([])
    } finally { rmSync(ws, {recursive: true, force: true}) }
  })

  it('③ 非 git 仓库返回空数组且不抛', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'pm-nogit-'))
    try {
      await expect(getGitAuthors(ws, {branch: 'main'})).resolves.toEqual([])
    } finally { rmSync(ws, {recursive: true, force: true}) }
  })

})

describe('parseShortlog', () => {
  it('④ 超过上限时按排序截断', () => {
    const lines: string[] = []
    for (let i = 0; i < MAX_AUTHOR_COUNT + 50; i++) {
      // i 越大提交数越大；只有前 MAX_AUTHOR_COUNT 名应存活
      lines.push(`${i + 1}\tAuthor${String(i).padStart(4, '0')} <a${i}@x.com>`)
    }
    const authors = parseShortlog(lines.join('\n') + '\n')
    expect(authors).toHaveLength(MAX_AUTHOR_COUNT)
    expect(authors[0]!.name).toBe(`Author${String(MAX_AUTHOR_COUNT + 49).padStart(4, '0')}`)
    expect(authors[authors.length - 1]!.commits).toBe(51)
  })

  it('容忍 CRLF / 空行 / 前导空白计数', () => {
    const raw = '     2\tAlice <alice@x.com>\r\n\r\n     1\tBob <bob@x.com>\r\n'
    expect(parseShortlog(raw)).toEqual([
      {name: 'Alice', email: 'alice@x.com', commits: 2},
      {name: 'Bob', email: 'bob@x.com', commits: 1},
    ])
  })

  it('空输入返回空数组', () => {
    expect(parseShortlog('')).toEqual([])
    expect(parseShortlog('\n\n')).toEqual([])
  })

  it('畸形行（无 <> 包裹 / 无 tab / 名称为空）不崩溃且语义明确', () => {
    expect(parseShortlog('3\tNoEmailHere\n')).toEqual([{name: 'NoEmailHere', email: '', commits: 3}])
    expect(parseShortlog('   <ghost@x.com>\n')).toEqual([])          // 缺计数 → 丢弃
    expect(parseShortlog('1\t <ghost@x.com>\n')).toEqual([{name: '', email: 'ghost@x.com', commits: 1}])
  })
})
