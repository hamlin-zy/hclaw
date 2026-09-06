import {describe, expect, it, vi, beforeEach} from 'vitest'

// Mock zustand — just re-export create
vi.mock('zustand', () => ({
  create: (initializer: (set: any, get: any) => any) => {
    let state: any = {}
    const setState = (partial: any) => {
      if (typeof partial === 'function') state = {...state, ...partial(state)}
      else state = {...state, ...partial}
    }
    const getState = () => state
    state = initializer(setState, getState)
    const useStore: any = (selector?: (s: any) => any) => selector ? selector(state) : state
    useStore.getState = getState
    useStore.setState = setState
    useStore.subscribe = () => () => {}
    return useStore
  },
}))

import {createUpdateStore} from '@/renderer/stores/createUpdateStore'

describe('createUpdateStore factory', () => {
  let mockGetAllVersionMeta: ReturnType<typeof vi.fn>

  beforeEach(() => {
    mockGetAllVersionMeta = vi.fn().mockResolvedValue({
      'srv1': {current: '1.0.0', latest: '2.0.0', hasUpdate: true, sourceType: 'binary', lastChecked: 0},
      'srv2': {current: '1.0.0', latest: '1.0.0', hasUpdate: false, sourceType: 'npx', lastChecked: 0},
    })
  })

  it('creates store with versionMeta, updateMap, hasUpdate', () => {
    const store = createUpdateStore({
      getAllVersionMeta: mockGetAllVersionMeta,
      setMethodName: 'setMcpUpdates' as const,
    })
    expect(store.getState().versionMeta).toEqual({})
    expect(store.getState().updateMap).toEqual({})
    expect(store.getState().hasUpdate).toBe(false)
  })

  it('setVersionMeta derives updateMap and hasUpdate', () => {
    const store = createUpdateStore({
      getAllVersionMeta: mockGetAllVersionMeta,
      setMethodName: 'setMcpUpdates' as const,
    })
    store.getState().setVersionMeta({
      'srv1': {current: '1.0.0', latest: '2.0.0', hasUpdate: true},
      'srv2': {current: '1.0.0', latest: '1.0.0', hasUpdate: false},
    })
    expect(store.getState().updateMap['srv1']).toBe(true)
    expect(store.getState().updateMap['srv2']).toBe(false)
    expect(store.getState().hasUpdate).toBe(true)
  })

  it('exposes domain-specific method name via setMethodName', () => {
    const store = createUpdateStore({
      getAllVersionMeta: mockGetAllVersionMeta,
      setMethodName: 'setMcpUpdates' as const,
    })
    expect(typeof store.getState().setMcpUpdates).toBe('function')
    store.getState().setMcpUpdates({'srv1': true})
    expect(store.getState().updateMap['srv1']).toBe(true)
    expect(store.getState().hasUpdate).toBe(true)
  })

  it('refreshFromCache pulls from IPC and sets versionMeta', async () => {
    const store = createUpdateStore({
      getAllVersionMeta: mockGetAllVersionMeta,
      setMethodName: 'setMcpUpdates' as const,
    })
    await store.getState().refreshFromCache()
    expect(mockGetAllVersionMeta).toHaveBeenCalled()
    expect(store.getState().versionMeta['srv1']).toBeDefined()
    expect(store.getState().hasUpdate).toBe(true)
  })

  it('clear resets all state', () => {
    const store = createUpdateStore({
      getAllVersionMeta: mockGetAllVersionMeta,
      setMethodName: 'setMcpUpdates' as const,
    })
    store.getState().setVersionMeta({'srv1': {current: '1.0.0', latest: '2.0.0', hasUpdate: true}})
    store.getState().clear()
    expect(store.getState().versionMeta).toEqual({})
    expect(store.getState().hasUpdate).toBe(false)
  })

  it('handles null hasUpdate values (three-state)', () => {
    const store = createUpdateStore({
      getAllVersionMeta: mockGetAllVersionMeta,
      setMethodName: 'setMcpUpdates' as const,
    })
    store.getState().setVersionMeta({
      'srv1': {current: null, latest: null, hasUpdate: null},
    })
    expect(store.getState().updateMap['srv1']).toBeNull()
    // null is falsy → hasUpdate should be false
    expect(store.getState().hasUpdate).toBe(false)
  })
})

describe('pluginUpdateStore regression', () => {
  it('factory produces compatible interface with old pluginUpdateStore', () => {
    const mockApi = vi.fn().mockResolvedValue({})
    const store = createUpdateStore({
      getAllVersionMeta: mockApi,
      setMethodName: 'setPluginUpdates' as const,
    })

    // Must have all methods that PluginDialog.tsx calls
    expect(typeof store.getState().setPluginUpdates).toBe('function')
    expect(typeof store.getState().setVersionMeta).toBe('function')
    expect(typeof store.getState().refreshFromCache).toBe('function')
    expect(typeof store.getState().clear).toBe('function')

    // setPluginUpdates should work as updateMap setter
    store.getState().setPluginUpdates({'plugin-a': true, 'plugin-b': false})
    expect(store.getState().updateMap['plugin-a']).toBe(true)
    expect(store.getState().updateMap['plugin-b']).toBe(false)
    expect(store.getState().hasUpdate).toBe(true)
  })

  it('factory produces compatible interface with old repoUpdateStore', () => {
    const mockApi = vi.fn().mockResolvedValue({})
    const store = createUpdateStore({
      getAllVersionMeta: mockApi,
      setMethodName: 'setRepoUpdates' as const,
    })

    expect(typeof store.getState().setRepoUpdates).toBe('function')
    expect(typeof store.getState().setVersionMeta).toBe('function')
    expect(typeof store.getState().refreshFromCache).toBe('function')
    expect(typeof store.getState().clear).toBe('function')

    store.getState().setRepoUpdates({'repo-1': true})
    expect(store.getState().hasUpdate).toBe(true)
  })

  it('setVersionMeta with non-null hasUpdate (old format compatibility)', () => {
    const mockApi = vi.fn().mockResolvedValue({})
    const store = createUpdateStore({
      getAllVersionMeta: mockApi,
      setMethodName: 'setPluginUpdates' as const,
    })

    // Old format: hasUpdate is boolean (not null)
    store.getState().setVersionMeta({
      'p1': {current: '1.0.0', latest: '2.0.0', hasUpdate: true},
      'p2': {current: '1.0.0', latest: '1.0.0', hasUpdate: false},
    })
    expect(store.getState().updateMap['p1']).toBe(true)
    expect(store.getState().updateMap['p2']).toBe(false)
    expect(store.getState().hasUpdate).toBe(true)
  })
})
