// tests/main/project-manager/numstat.test.ts
// 单测 parseNumstat：锁定既有 numstat 聚合行为（与改造前 status.ts / diff.ts 内联循环逐条等价）
import {describe, it, expect} from 'vitest'
import {parseNumstat} from '../../../src/main/project-manager/git/numstat'

describe('parseNumstat', () => {
  it('常规多行：逐行累加 add/del（第 3 列文件名忽略）', () => {
    expect(parseNumstat('2\t1\ta.ts\n3\t0\tb.ts\n')).toEqual({additions: 5, deletions: 1})
  })

  it('二进制行 `-`：add/del 均跳过', () => {
    expect(parseNumstat('-\t-\tbin.png\n')).toEqual({additions: 0, deletions: 0})
  })

  it('二进制行与正常行混合：只累加正常行', () => {
    expect(parseNumstat('1\t2\tx.ts\n-\t-\tbin.png\n4\t0\ty.ts\n')).toEqual({additions: 5, deletions: 2})
  })

  it('仅 add 为 `-` / 仅 del 为 `-`：各自独立跳过', () => {
    expect(parseNumstat('-\t7\tf\n8\t-\tg\n')).toEqual({additions: 8, deletions: 7})
  })

  it('空串：0/0', () => {
    expect(parseNumstat('')).toEqual({additions: 0, deletions: 0})
  })

  it('仅换行（一个或多个）：0/0', () => {
    expect(parseNumstat('\n')).toEqual({additions: 0, deletions: 0})
    expect(parseNumstat('\n\n\n')).toEqual({additions: 0, deletions: 0})
  })

  it('行尾无换行与有换行结果一致', () => {
    expect(parseNumstat('5\t0\ta.ts')).toEqual({additions: 5, deletions: 0})
    expect(parseNumstat('5\t0\ta.ts\n')).toEqual({additions: 5, deletions: 0})
    expect(parseNumstat('5\t0\ta.ts')).toEqual(parseNumstat('5\t0\ta.ts\n'))
  })

  it('中间混入空行：空行被跳过，不影响累加', () => {
    expect(parseNumstat('2\t1\ta.ts\n\n3\t0\tb.ts\n')).toEqual({additions: 5, deletions: 1})
  })

  it('缺列（只有 add）：del 为 undefined，跳过', () => {
    expect(parseNumstat('5\n')).toEqual({additions: 5, deletions: 0})
  })

  it('多列：以 [add, del] 前两列为准，忽略后续列', () => {
    expect(parseNumstat('5\t0\textra\tmore\n')).toEqual({additions: 5, deletions: 0})
  })

  it('parseInt 既有语义：非数字产生 NaN（不得被吞成 0）', () => {
    const r = parseNumstat('foo\tbar\tx.ts\n')
    expect(Number.isNaN(r.additions)).toBe(true)
    expect(Number.isNaN(r.deletions)).toBe(true)
    // 单列非数字：只影响 additions，deletions 保持 0
    const s = parseNumstat('abc\n')
    expect(Number.isNaN(s.additions)).toBe(true)
    expect(s.deletions).toBe(0)
  })

  it('parseInt 截断小数（不四舍五入、不用 Number()）', () => {
    expect(parseNumstat('3.7\t2.9\tf\n')).toEqual({additions: 3, deletions: 2})
  })

  it('parseInt 前缀解析：1e3 -> 1，0x10 -> 0', () => {
    expect(parseNumstat('1e3\t2\tf\n')).toEqual({additions: 1, deletions: 2})
    expect(parseNumstat('0x10\t1\tf\n')).toEqual({additions: 0, deletions: 1})
  })

  it('负数与零照常累加', () => {
    expect(parseNumstat('-5\t2\tq\n')).toEqual({additions: -5, deletions: 2})
    expect(parseNumstat('0\t0\tz\n')).toEqual({additions: 0, deletions: 0})
  })
})
