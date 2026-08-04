// @vitest-environment jsdom
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import {render, screen, fireEvent} from '@testing-library/react'
import AudioPreviewPlayer from '../../../../src/renderer/components/message-list/AudioPreviewPlayer'

// mock HTMLAudioElement.play/pause（jsdom 未实现）
beforeEach(() => {
    HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined)
    HTMLMediaElement.prototype.pause = vi.fn()
})

afterEach(() => {
    vi.restoreAllMocks()
})

describe('AudioPreviewPlayer toggle（Task 4 改写后的播放/暂停分支）', () => {
    it('点击后调用 audio.play() 并切换到播放状态（pause 未被调用）', () => {
        render(<AudioPreviewPlayer url="file:///test.mp3" fileName="test.mp3" />)
        // 播放/暂停按钮是第一个 button（第二个为静音切换）
        const btn = screen.getAllByRole('button')[0]
        fireEvent.click(btn)
        expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1)
        expect(HTMLMediaElement.prototype.pause).not.toHaveBeenCalled()
    })

    it('再次点击后调用 audio.pause()（play 只调用一次）', () => {
        render(<AudioPreviewPlayer url="file:///test.mp3" fileName="test.mp3" />)
        const btn = screen.getAllByRole('button')[0]
        fireEvent.click(btn)
        fireEvent.click(btn)
        expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1)
        expect(HTMLMediaElement.prototype.pause).toHaveBeenCalledTimes(1)
    })
})
