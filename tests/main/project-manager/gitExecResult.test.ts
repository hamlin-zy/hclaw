import {describe, it, expect} from 'vitest'
import {mkdtempSync, writeFileSync, rmSync} from 'fs'
import {tmpdir} from 'os'
import {join} from 'path'
import {execFileSync} from 'child_process'
import {gitExecResult} from '../../../src/main/project-manager/git/gitExec'

function makeRepo(): string {
  const ws = mkdtempSync(join(tmpdir(), 'pm-exec-'))
  execFileSync('git', ['init'], {cwd: ws, stdio: 'ignore'})
  return ws
}

describe('gitExecResult', () => {
  it('退出码 0 时返回 stdout 与 code 0', async () => {
    const ws = makeRepo()
    try {
      const r = await gitExecResult(ws, ['rev-parse', '--is-inside-work-tree'])
      expect(r.code).toBe(0)
      expect(r.stdout.trim()).toBe('true')
    } finally { rmSync(ws, {recursive: true, force: true}) }
  })

  it('回归：退出码 1 也 resolve，不 reject —— 这是它存在的唯一理由', async () => {
    const ws = makeRepo()
    try {
      writeFileSync(join(ws, 'a.ts'), 'x')   // 无 .gitignore → check-ignore 退出码 1
      const r = await gitExecResult(ws, ['check-ignore', '--stdin', '-z'], 'a.ts\0')
      expect(r.code).toBe(1)
      expect(r.stdout).toBe('')
    } finally { rmSync(ws, {recursive: true, force: true}) }
  })

  it('非 git 仓库返回 code 128，不 reject', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'pm-nogit-'))
    try {
      const r = await gitExecResult(ws, ['rev-parse', '--is-inside-work-tree'])
      expect(r.code).not.toBe(0)
    } finally { rmSync(ws, {recursive: true, force: true}) }
  })

  it('stdin 传多路径时按 NUL 分隔输出命中项', async () => {
    const ws = makeRepo()
    try {
      writeFileSync(join(ws, '.gitignore'), 'dist/\n*.log\n')
      writeFileSync(join(ws, 'debug.log'), 'x')
      writeFileSync(join(ws, 'keep.ts'), 'x')
      const r = await gitExecResult(ws, ['check-ignore', '--stdin', '-z'], 'debug.log\0keep.ts\0')
      expect(r.code).toBe(0)
      expect(r.stdout.split('\0').filter(Boolean)).toEqual(['debug.log'])
    } finally { rmSync(ws, {recursive: true, force: true}) }
  })
})
