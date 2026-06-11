/**
 * 音频预览播放器组件
 */

import {memo, useCallback, useRef, useState} from 'react'

interface AudioPreviewPlayerProps {
    url: string
    fileName?: string
}

/** 格式化时间为 mm:ss */
const formatTime = (seconds: number): string => {
    const m = Math.floor(seconds / 60)
    const s = Math.floor(seconds % 60)
    return `${m}:${s.toString().padStart(2, '0')}`
}

const AudioPreviewPlayer = memo(function AudioPreviewPlayer({url, fileName}: AudioPreviewPlayerProps) {
    const audioRef = useRef<HTMLAudioElement>(null)
    const [playing, setPlaying] = useState(false)
    const [currentTime, setCurrentTime] = useState(0)
    const [duration, setDuration] = useState(0)
    const [volume, setVolume] = useState(1)

    const togglePlay = useCallback(() => {
        const audio = audioRef.current
        if (!audio) return
        playing ? audio.pause() : audio.play()
        setPlaying(!playing)
    }, [playing])

    const onTimeUpdate = useCallback(() => {
        setCurrentTime(audioRef.current?.currentTime ?? 0)
    }, [])

    const onLoadedMetadata = useCallback(() => {
        setDuration(audioRef.current?.duration ?? 0)
    }, [])

    const onEnded = useCallback(() => {
        setPlaying(false)
        setCurrentTime(0)
    }, [])

    const seek = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        const time = Number(e.target.value)
        if (audioRef.current) audioRef.current.currentTime = time
        setCurrentTime(time)
    }, [])

    const changeVolume = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        const vol = Number(e.target.value)
        if (audioRef.current) audioRef.current.volume = vol
        setVolume(vol)
    }, [])

    const toggleMute = useCallback(() => {
        if (!audioRef.current) return
        const newVol = volume > 0 ? 0 : 1
        audioRef.current.volume = newVol
        setVolume(newVol)
    }, [volume])

    const progressPercent = duration ? (currentTime / duration) * 100 : 0

    return (
        <div className="mt-2 p-3 rounded-lg bg-[var(--surface-muted)]/40 border border-[var(--border)]/30">
            <audio ref={audioRef} src={url} onTimeUpdate={onTimeUpdate} onLoadedMetadata={onLoadedMetadata}
                   onEnded={onEnded}/>

            {fileName && (
                <div className="text-xs text-[var(--text-muted)] mb-2 truncate flex items-center gap-1">
                    <svg className="w-4 h-4 text-pink-500 shrink-0" fill="currentColor" viewBox="0 0 20 20">
                        <path
                            d="M18 3a1 1 0 00-1.196-.98l-10 2A1 1 0 006 5v9.114A4.369 4.369 0 005 14c-1.657 0-3 .895-3 2s1.343 2 3 2 3-.895 3-2V7.82l8-1.6v5.78A4.37 4.37 0 0015 12c-1.657 0-3 .895-3 2s1.343 2 3 2 3-.895 3-2V3z"/>
                    </svg>
                    <span className="font-mono">{fileName}</span>
                </div>
            )}

            <div className="flex items-center gap-3">
                <button onClick={togglePlay}
                        className="w-10 h-10 rounded-full bg-pink-500 hover:bg-pink-600 text-white flex items-center justify-center transition-colors shrink-0">
                    {playing ? (
                        <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                            <path d="M6 4h4v12H6V4zm6 0h4v12h-4V4z"/>
                        </svg>
                    ) : (
                        <svg className="w-5 h-5 ml-0.5" fill="currentColor" viewBox="0 0 20 20">
                            <path
                                d="M6.3 2.841A1.5 1.5 0 004 4.11V15.89a1.5 1.5 0 002.3 1.269l9.344-5.89a1.5 1.5 0 000-2.538L6.3 2.84z"/>
                        </svg>
                    )}
                </button>

                <span
                    className="text-[11px] text-[var(--text-muted)] font-mono w-10 shrink-0">{formatTime(currentTime)}</span>

                <input type="range" min="0" max={duration || 0} value={currentTime} onChange={seek}
                       className="flex-1 h-1.5 rounded-full appearance-none bg-[var(--border)] cursor-pointer
                        [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 
                        [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-pink-500"
                       style={{background: duration ? `linear-gradient(to right, #ec4899 ${progressPercent}%, var(--border) ${progressPercent}%)` : undefined}}/>

                <span
                    className="text-[11px] text-[var(--text-muted)] font-mono w-10 shrink-0 text-right">{formatTime(duration)}</span>

                <div className="flex items-center gap-1 shrink-0">
                    <button onClick={toggleMute}
                            className="text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors">
                        {volume > 0 ? (
                            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                                <path
                                    d="M9.383 3.076A1 1 0 0110 4v12a1 1 0 01-1.707.707L4.586 13H2a1 1 0 01-1-1V8a1 1 0 011-1h2.586l3.707-3.707a1 1 0 011.09-.217zM14.657 2.929a1 1 0 011.414 0A9.972 9.972 0 0119 10a9.972 9.972 0 01-2.929 7.071 1 1 0 01-1.414-1.414A7.971 7.971 0 0017 10c0-2.21-.894-4.208-2.343-5.657a1 1 0 010-1.414z"/>
                            </svg>
                        ) : (
                            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                                <path
                                    d="M9.383 3.076A1 1 0 0110 4v12a1 1 0 01-1.707.707L4.586 13H2a1 1 0 01-1-1V8a1 1 0 011-1h2.586l3.707-3.707a1 1 0 011.09-.217zM13.293 7.293a1 1 0 011.414 1.414l-2 2a1 1 0 01-1.414-1.414l2-2zM7.293 14.707a1 1 0 011.414-1.414l2 2a1 1 0 01-1.414 1.414l-2-2z"/>
                            </svg>
                        )}
                    </button>
                    <input type="range" min="0" max="1" step="0.1" value={volume} onChange={changeVolume}
                           className="w-16 h-1.5 rounded-full appearance-none bg-[var(--border)] cursor-pointer
                            [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-2 [&::-webkit-slider-thumb]:h-2 
                            [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-pink-500"/>
                </div>
            </div>
        </div>
    )
})

export default AudioPreviewPlayer
