import {describe, it, expect, beforeEach, afterEach} from 'vitest'
import {writeFileSync, mkdirSync, rmSync} from 'fs'
import {join} from 'path'
import {loadMemory, readIndex, ensureMemoryDir, ensureIndex} from '../../../src/main/agent/memory/memoryLoader'
import {computeMemoryDigest, computeMemoryDigest as digestFromStore} from '../../../src/main/agent/memory/memoryStore'

describe('memoryLoader', () => {
  const tmpDir = join(process.env.TEMP || '/tmp', 'hclaw-mem-test')

  beforeEach(() => { rmSync(tmpDir, {recursive: true, force: true}) })
  afterEach(() => { rmSync(tmpDir, {recursive: true, force: true}) })

  it('should return null when mem/ does not exist', () => {
    const result = loadMemory(tmpDir, 'E:\\workspace\\test')
    expect(result).toBeNull()
  })

  it('should load SKILL.md and preferences only when workspace not in index', () => {
    ensureMemoryDir(tmpDir)
    writeFileSync(join(tmpDir, 'mem', 'SKILL.md'), '---\nname: user-memory\n---\n# Memory')
    mkdirSync(join(tmpDir, 'mem', 'ref', '_user'), {recursive: true})
    writeFileSync(join(tmpDir, 'mem', 'ref', '_user', 'preferences.md'), '# Prefs')
    const result = loadMemory(tmpDir, 'E:\\workspace\\unknown')
    expect(result).not.toBeNull()
    expect(result!.skillMd).toContain('# Memory')
    expect(result!.preferencesMd).toContain('# Prefs')
    expect(result!.projectMemoryMd).toBeNull()
  })

  it('should load project memory when workspace matches index', () => {
    ensureMemoryDir(tmpDir)
    writeFileSync(join(tmpDir, 'mem', 'SKILL.md'), '# Memory')
    mkdirSync(join(tmpDir, 'mem', 'ref', '_user'), {recursive: true})
    writeFileSync(join(tmpDir, 'mem', 'ref', '_user', 'preferences.md'), '# Prefs')
    mkdirSync(join(tmpDir, 'mem', 'ref', 'hclaw'), {recursive: true})
    writeFileSync(join(tmpDir, 'mem', 'ref', 'hclaw', 'memory.md'), '# HClaw Memory')
    writeFileSync(join(tmpDir, 'mem', 'ref', 'index.json'),
      JSON.stringify({'E:\\workspace\\hclaw': {dir: 'hclaw', projectName: 'HClaw'}}))
    const result = loadMemory(tmpDir, 'E:\\workspace\\hclaw')
    expect(result!.projectMemoryMd).toContain('# HClaw Memory')
    expect(result!.projectName).toBe('HClaw')
  })

  it('readIndex should return null for missing index and object for existing', () => {
    expect(readIndex(tmpDir)).toBeNull()
    ensureIndex(tmpDir)
    expect(readIndex(tmpDir)).toEqual({})
  })

  it('computeMemoryDigest should change when content changes', () => {
    const a = computeMemoryDigest({skillMd: 'a', preferencesMd: null, projectMemoryMd: null, projectName: null})
    const b = computeMemoryDigest({skillMd: 'b', preferencesMd: null, projectMemoryMd: null, projectName: null})
    const c = digestFromStore({skillMd: 'a', preferencesMd: null, projectMemoryMd: null, projectName: null})
    expect(a).not.toBe(b)
    expect(a).toBe(c)
  })
})
