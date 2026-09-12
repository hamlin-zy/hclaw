import {describe, expect, it} from 'vitest'
import {absPath} from '../../../src/renderer/project-manager/lib/absPath'

describe('absPath', () => {
  it('POSIX 工作区与相对路径拼接', () => {
    expect(absPath('/home/me/proj', 'src/a.ts')).toBe('/home/me/proj/src/a.ts')
  })

  it('去除工作区尾部分隔符（兼容 / 与 \\）', () => {
    expect(absPath('/home/me/proj/', 'src/a.ts')).toBe('/home/me/proj/src/a.ts')
    expect(absPath('C:\\work\\proj\\', 'src/a.ts')).toBe('C:\\work\\proj/src/a.ts')
  })

  it("relPath 为 '.' → 工作区根（去尾分隔符）", () => {
    expect(absPath('/home/me/proj/', '.')).toBe('/home/me/proj')
  })

  it('relPath 为空串 → 工作区根', () => {
    expect(absPath('C:\\work\\proj\\', '')).toBe('C:\\work\\proj')
  })
})
