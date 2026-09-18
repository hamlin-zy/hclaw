import {describe, expect, it} from 'vitest'
import fs from 'fs'
import path from 'path'

const CONFIG_IPC = path.resolve(process.cwd(), 'src/main/ipc/configIPC.ts')
const PRELOAD_TS = path.resolve(process.cwd(), 'src/preload/index.ts')
const ENV_DTS = path.resolve(process.cwd(), 'src/renderer/env.d.ts')

describe('workspace:getGitBranches —— 批量只读分支', () => {
    it('handler 存在，且只调 getGitBranch（不得调用 startGitBranchWatch）', () => {
        const src = fs.readFileSync(CONFIG_IPC, 'utf-8')
        const start = src.indexOf("ipcMain.handle('workspace:getGitBranches'")
        expect(start).toBeGreaterThan(-1)
        const body = src.slice(start, start + 900)
        expect(body).toContain('getGitBranch(')
        expect(body).not.toContain('startGitBranchWatch')
    })

    it('空/非法入参返回空对象，不抛', () => {
        const src = fs.readFileSync(CONFIG_IPC, 'utf-8')
        const start = src.indexOf("ipcMain.handle('workspace:getGitBranches'")
        const body = src.slice(start, start + 900)
        expect(body).toContain('Array.isArray(paths)')
    })

    it('preload / env.d.ts 暴露 getGitBranches', () => {
        expect(fs.readFileSync(PRELOAD_TS, 'utf-8')).toContain("ipcRenderer.invoke('workspace:getGitBranches', paths)")
        expect(fs.readFileSync(ENV_DTS, 'utf-8')).toContain('getGitBranches:')
    })
})
