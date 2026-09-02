import {beforeEach, describe, expect, it, vi} from 'vitest'

// 用 zustand 的 getState/setState mock 验证 setVersionMeta 派生
const mockElectron = vi.hoisted(() => ({ getAllVersionMeta: vi.fn() }))
vi.stubGlobal('window', {electronAPI: {repo: mockElectron}})

beforeEach(() => { mockElectron.getAllVersionMeta.mockReset() })

describe('repoUpdateStore', () => {
  it('setVersionMeta 派生 updateMap + hasUpdate', async () => {
    const {useRepoUpdateStore} = await import('@/renderer/stores/repoUpdateStore')
    useRepoUpdateStore.getState().setVersionMeta({'obra/x': {current: 'v1', latest: 'v2', hasUpdate: true}})
    const s = useRepoUpdateStore.getState()
    expect(s.updateMap['obra/x']).toBe(true)
    expect(s.hasUpdate).toBe(true)
  })
  it('refreshFromCache 从 IPC 拉取并写入', async () => {
    mockElectron.getAllVersionMeta.mockResolvedValue({'me/y': {current: 'v1', latest: 'v1', hasUpdate: false}})
    const {useRepoUpdateStore} = await import('@/renderer/stores/repoUpdateStore')
    await useRepoUpdateStore.getState().refreshFromCache()
    expect(useRepoUpdateStore.getState().hasUpdate).toBe(false)
    expect(useRepoUpdateStore.getState().versionMeta['me/y']).toEqual({current: 'v1', latest: 'v1', hasUpdate: false})
  })
  it('clear 重置', async () => {
    const {useRepoUpdateStore} = await import('@/renderer/stores/repoUpdateStore')
    useRepoUpdateStore.getState().setRepoUpdates({'a': true})
    useRepoUpdateStore.getState().clear()
    expect(useRepoUpdateStore.getState().hasUpdate).toBe(false)
  })
})
