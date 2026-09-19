/**
 * checkScheduleWorkspace isSystem 旁路测试（Task 3）
 *
 * 系统内置任务（isSystem=true）没有工作目录约束，直接返回 ok，旁路所有工作目录判定。
 * 三条断言：
 *   1. isSystem=true 时 null workspaceId → ok（旁路生效）
 *   2. isSystem=false 时 null workspaceId → unset（原有行为不变）
 *   3. isSystem 缺省（undefined）时 null workspaceId → unset（向后兼容）
 */
import {describe, it, expect} from 'vitest'
import {checkScheduleWorkspace} from '../../../src/main/scheduler/scheduleWorkspace'

describe('checkScheduleWorkspace isSystem bypass', () => {
  it('should return ok for null workspaceId when isSystem=true', () => {
    const result = checkScheduleWorkspace(null, undefined, true)
    expect(result.state).toBe('ok')
    expect(result.path).toBeNull()
    expect(result.reason).toBeNull()
  })

  it('should return unset for null workspaceId when isSystem=false', () => {
    const result = checkScheduleWorkspace(null, undefined, false)
    expect(result.state).toBe('unset')
    expect(result.path).toBeNull()
  })

  it('should return unset for null workspaceId when isSystem undefined (backward compat)', () => {
    const result = checkScheduleWorkspace(null)
    expect(result.state).toBe('unset')
  })

  it('should return ok for missing workspace when isSystem=true', () => {
    const result = checkScheduleWorkspace('ws-does-not-exist', undefined, true)
    expect(result.state).toBe('ok')
    expect(result.path).toBeNull()
  })

  it('should bypass deps when isSystem=true (deps not consulted)', () => {
    // 即使 deps 会抛异常，isSystem 旁路也不该碰它
    const throwingDeps = {
      findWorkspace: () => { throw new Error('should not be called') },
      isDirectory: () => { throw new Error('should not be called') },
    }
    const result = checkScheduleWorkspace('any-id', throwingDeps, true)
    expect(result.state).toBe('ok')
  })
})
