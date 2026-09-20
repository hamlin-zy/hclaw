import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

const tmpRoot = path.join(os.tmpdir(), `hclaw-companion-test-${process.pid}`)
let mockDir = ''

vi.mock('../../../src/main/hclawPaths', () => ({
    getHclawDir: () => mockDir,
}))

import {readCompanionConfig, upsertCompanionApp, removeCompanionApp, getCompanionConfigPath} from '../../../src/main/companion/companionConfig'
import type {CompanionApp} from '../../../src/shared/types/companion'

function makeApp(overrides: Partial<CompanionApp> = {}): CompanionApp {
    return {
        id: '', name: 'Obsidian', exePath: 'C:\\apps\\Obsidian.exe', args: [],
        processName: 'Obsidian.exe', launchTiming: 'after',
        waitForReady: false, enabled: true, ...overrides,
    }
}

beforeEach(() => {
    mockDir = path.join(tmpRoot, String(Date.now()))
    fs.mkdirSync(mockDir, {recursive: true})
})
afterEach(() => {
    fs.rmSync(tmpRoot, {recursive: true, force: true})
})

describe('readCompanionConfig', () => {
    it('文件不存在返回空数组', () => {
        expect(readCompanionConfig()).toEqual([])
    })
    it('JSON 损坏返回空数组（不抛异常）', () => {
        fs.writeFileSync(getCompanionConfigPath(), '{broken json', 'utf8')
        expect(readCompanionConfig()).toEqual([])
    })
    it('apps 字段缺失/非数组返回空数组', () => {
        fs.writeFileSync(getCompanionConfigPath(), JSON.stringify({foo: 1}), 'utf8')
        expect(readCompanionConfig()).toEqual([])
    })
    it('正常读取', () => {
        const app = {...makeApp(), id: 'companion-x'}
        fs.writeFileSync(getCompanionConfigPath(), JSON.stringify({apps: [app]}), 'utf8')
        expect(readCompanionConfig()).toEqual([app])
    })
})

describe('upsertCompanionApp', () => {
    it('新增：id 为空时由 hashName(name) 生成并回传，前缀 companion-', () => {
        const id = upsertCompanionApp(makeApp())
        expect(id).toMatch(/^companion-/)
        const apps = readCompanionConfig()
        expect(apps).toHaveLength(1)
        expect(apps[0].id).toBe(id)
    })
    it('【Review Focus 1】同名重复添加（hash 碰撞）：覆盖旧项而非出现两条', () => {
        const id1 = upsertCompanionApp(makeApp({exePath: 'C:\\old\\Obsidian.exe'}))
        upsertCompanionApp(makeApp({exePath: 'C:\\new\\Obsidian.exe'}))
        const apps = readCompanionConfig()
        expect(apps).toHaveLength(1)
        expect(apps[0].id).toBe(id1)
        expect(apps[0].exePath).toBe('C:\\new\\Obsidian.exe')
    })
    it('更新：带已存在 id 时原地替换，不回传新 id 语义（id 不变）', () => {
        const id = upsertCompanionApp(makeApp({processName: 'Obsidian.exe'}))
        upsertCompanionApp(makeApp({id, processName: 'Obsidian2.exe'}))
        const apps = readCompanionConfig()
        expect(apps).toHaveLength(1)
        expect(apps[0].processName).toBe('Obsidian2.exe')
        expect(apps[0].id).toBe(id)
    })
    it('原子写入：目标目录无 .tmp 残留，文件内容为合法 JSON', () => {
        upsertCompanionApp(makeApp())
        const files = fs.readdirSync(mockDir)
        expect(files).toContain('companion-apps.json')
        expect(files.filter(f => f.endsWith('.tmp'))).toHaveLength(0)
        expect(() => JSON.parse(fs.readFileSync(getCompanionConfigPath(), 'utf8'))).not.toThrow()
    })
})

describe('removeCompanionApp', () => {
    it('按 id 删除', () => {
        const id = upsertCompanionApp(makeApp())
        removeCompanionApp(id)
        expect(readCompanionConfig()).toEqual([])
    })
    it('【幂等】id 不存在返回成功且不重写文件（mtime 不变）', () => {
        const id = upsertCompanionApp(makeApp())
        const before = fs.statSync(getCompanionConfigPath()).mtimeMs
        expect(() => removeCompanionApp('companion-nonexistent')).not.toThrow()
        expect(fs.statSync(getCompanionConfigPath()).mtimeMs).toBe(before)
        expect(readCompanionConfig()).toHaveLength(1)
    })
})
