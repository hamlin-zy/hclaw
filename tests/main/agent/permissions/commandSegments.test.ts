/**
 * commandSegments 单元测试
 *
 * 覆盖复合命令切段（;、&&、||、|、换行、单 &）与写操作段识别：
 * - 引号内分隔符不切
 * - `\` / PowerShell 反引号转义下一个字符
 * - 括号深度 > 0 不切
 * - 连续分隔符、空段过滤
 * - 未闭合引号按单段处理（fail-safe）
 */
import {describe, expect, it} from 'vitest'
import {isWriteSegment, splitCommandSegments} from '@/main/agent/permissions/commandSegments'

describe('splitCommandSegments', () => {
  it('按 ; 切分并 trim 每段', () => {
    expect(splitCommandSegments('cd X; Get-Content Y')).toEqual(['cd X', 'Get-Content Y'])
  })

  it('按 && 切分', () => {
    expect(splitCommandSegments('cd X && npm test')).toEqual(['cd X', 'npm test'])
  })

  it('按 || 切分', () => {
    expect(splitCommandSegments('cat a || cat b')).toEqual(['cat a', 'cat b'])
  })

  it('按管道 | 切分', () => {
    expect(splitCommandSegments('git status | Select-String foo')).toEqual(['git status', 'Select-String foo'])
  })

  it('按换行切分（含 CRLF）', () => {
    expect(splitCommandSegments('cd X\nGet-ChildItem')).toEqual(['cd X', 'Get-ChildItem'])
    expect(splitCommandSegments('cd X\r\nls')).toEqual(['cd X', 'ls'])
  })

  it('双引号内的分隔符不切', () => {
    expect(splitCommandSegments('echo "a;b && c | d"')).toEqual(['echo "a;b && c | d"'])
  })

  it('单引号内的分隔符不切', () => {
    expect(splitCommandSegments("echo 'a;b && c'")).toEqual(["echo 'a;b && c'"])
  })

  it('反斜杠转义的分隔符不切', () => {
    expect(splitCommandSegments('echo a\\; b')).toEqual(['echo a\\; b'])
  })

  it('PowerShell 反引号转义的分隔符不切', () => {
    expect(splitCommandSegments('echo a`; b')).toEqual(['echo a`; b'])
  })

  it('括号深度 > 0 时不切', () => {
    expect(splitCommandSegments('echo $(cd X; ls)')).toEqual(['echo $(cd X; ls)'])
    expect(splitCommandSegments('(cd X; ls)')).toEqual(['(cd X; ls)'])
  })

  it('连续分隔符与空段被过滤', () => {
    expect(splitCommandSegments('ls ;; pwd')).toEqual(['ls', 'pwd'])
    expect(splitCommandSegments('ls && && pwd')).toEqual(['ls', 'pwd'])
    expect(splitCommandSegments('  ;  ')).toEqual([])
  })

  it('单个 & 也视为分隔符（后台执行同样构成复合命令）', () => {
    expect(splitCommandSegments('echo hi & rm x')).toEqual(['echo hi', 'rm x'])
  })

  it('未闭合引号按单段处理（fail-safe）', () => {
    expect(splitCommandSegments('echo "a; ls')).toEqual(['echo "a; ls'])
  })

  it('空命令返回空数组', () => {
    expect(splitCommandSegments('')).toEqual([])
    expect(splitCommandSegments('   ')).toEqual([])
  })
})

describe('isWriteSegment', () => {
  it('重定向 > / >> 视为写', () => {
    expect(isWriteSegment('echo hi > f')).toBe(true)
    expect(isWriteSegment('echo hi >> f')).toBe(true)
  })

  it('PowerShell 写 cmdlet 视为写', () => {
    expect(isWriteSegment('Set-Content -Path a -Value b')).toBe(true)
    expect(isWriteSegment('Out-File -FilePath a')).toBe(true)
    expect(isWriteSegment('Add-Content -Path a -Value b')).toBe(true)
  })

  it('tee 视为写', () => {
    expect(isWriteSegment('tee out.txt')).toBe(true)
    expect(isWriteSegment('cat a | tee b')).toBe(true)
  })

  it('sed -i 视为写，sed 无 -i 不视为写', () => {
    expect(isWriteSegment("sed -i 's/a/b/' f")).toBe(true)
    expect(isWriteSegment("sed -Ei 's/a/b/' f")).toBe(true)
    expect(isWriteSegment("sed 's/a/b/' f")).toBe(false)
  })

  it('node 写文件 API 视为写', () => {
    expect(isWriteSegment(`node -e "require('fs').writeFileSync('x','')"`)).toBe(true)
    expect(isWriteSegment(`[IO.File]::WriteAllText('x','')`)).toBe(true)
  })

  it('只读段不视为写', () => {
    expect(isWriteSegment('Get-Content a')).toBe(false)
    expect(isWriteSegment('git status')).toBe(false)
    expect(isWriteSegment('cd X')).toBe(false)
  })
})
