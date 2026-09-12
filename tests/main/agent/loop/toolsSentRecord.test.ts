/**
 * tools 发送记录（system_settings 持久化）单测。
 *
 * 覆盖缺陷 1（跨 run 持久化）与缺陷 5（顺序敏感比较）：
 * 记录必须落 DB 且按 conversationId 隔离，新 Worker 读得到；
 * 比较必须顺序敏感（tools 编码顺序变化同样断缓存）。
 */
import {describe, it, expect, vi, beforeEach} from 'vitest'

const store = vi.hoisted(() => ({data: {} as Record<string, string>}))

vi.mock('../../../../src/main/repositories/sqlite/systemSettingsRepository', () => ({
    systemSettingsRepo: {
        get: (key: string) => store.data[key] ?? null,
        set: (key: string, value: string) => {
            store.data[key] = value
            return true
        },
        getJson: (key: string) => {
            const raw = store.data[key]
            return raw ? JSON.parse(raw) : null
        },
        setJson: (key: string, value: unknown) => {
            store.data[key] = JSON.stringify(value)
            return true
        },
        delete: (key: string) => {
            delete store.data[key]
            return true
        },
        getAll: () => ({...store.data}),
    },
}))

import {getLastSentToolNames, recordLastSentToolNames, isSameToolNameSequence} from '../../../../src/main/agent/loop/toolsSentRecord'

beforeEach(() => {
    store.data = {}
})

describe('toolsSentRecord 持久化读写', () => {
    it('写入后可读回（跨 Worker 生命周期：数据在 system_settings 而非模块内存）', () => {
        recordLastSentToolNames('conv-a', ['read_file', 'write_file'])
        expect(getLastSentToolNames('conv-a')).toEqual(['read_file', 'write_file'])
    })

    it('按 conversationId 隔离', () => {
        recordLastSentToolNames('conv-a', ['read_file'])
        recordLastSentToolNames('conv-b', ['glob'])
        expect(getLastSentToolNames('conv-a')).toEqual(['read_file'])
        expect(getLastSentToolNames('conv-b')).toEqual(['glob'])
    })

    it('重复写入覆盖为最新一轮', () => {
        recordLastSentToolNames('conv-a', ['read_file'])
        recordLastSentToolNames('conv-a', ['read_file', 'write_file'])
        expect(getLastSentToolNames('conv-a')).toEqual(['read_file', 'write_file'])
    })

    it('无记录 / 结构损坏 → undefined', () => {
        expect(getLastSentToolNames('nope')).toBeUndefined()
        store.data['tools_sent_last:bad'] = '{"not":"an array"}'
        expect(getLastSentToolNames('bad')).toBeUndefined()
        store.data['tools_sent_last:bad2'] = 'not-json'
        expect(getLastSentToolNames('bad2')).toBeUndefined()
    })
})

describe('isSameToolNameSequence（顺序敏感）', () => {
    it('相同顺序 → true', () => {
        expect(isSameToolNameSequence(['a', 'b'], ['a', 'b'])).toBe(true)
    })

    it('长度不同 → false', () => {
        expect(isSameToolNameSequence(['a'], ['a', 'b'])).toBe(false)
    })

    it('集合相同但顺序不同 → false（tools 编码顺序变化同样断缓存）', () => {
        expect(isSameToolNameSequence(['a', 'b'], ['b', 'a'])).toBe(false)
    })
})
