/**
 * 统一媒体播放器组件
 * 根据媒体类型自动选择 audio/image/video 渲染方式
 *
 * 支持:
 * - hclaw-media:// 本地文件协议（由主进程自定义协议处理）
 * - file:// URL（配合 webSecurity: false 主进程配置）
 * - https:// 网络地址
 * - data: URI
 */

import {memo, useCallback, useEffect, useRef, useState} from 'react'
import type {MediaBlock} from '@shared/types'
import ImagePreviewModal from '../common/ImagePreviewModal'

interface MediaPlayerProps {
    media: MediaBlock
}

/** 格式化时间为 mm:ss */
const formatTime = (seconds: number): string => {
    const m = Math.floor(seconds / 60)
    const s = Math.floor(seconds % 60)
    return `${m}:${s.toString().padStart(2, '0')}`
}

/**
 * 将本地文件路径转换为 hclaw-media:// URL
 * C:\path\to\file.mp3 → hclaw-media:///C:/path/to/file.mp3
 * /home/user/file.mp3 → hclaw-media:///home/user/file.mp3
 */
export function toMediaUrl(urlOrPath: string): string {
    if (!urlOrPath) return ''

    // 解码 percent-encoded 字符（micromark 的 sanitizeUri 会将反斜杠编码为 %5C）
    let normalized = urlOrPath
    if (urlOrPath.includes('%')) {
        try {
            normalized = decodeURIComponent(urlOrPath)
        } catch { /* 保持原始值 */
        }
    }

    // 统一反斜杠为正斜杠
    normalized = normalized.replace(/\\/g, '/')

    // file:// 协议 → 转为 hclaw-media://（renderer 无法直接加载 file://）
    if (normalized.startsWith('file://')) {
        const path = normalized.slice(7) // remove 'file://'
        return toMediaUrl(path)          // recurse to handle the raw path
    }

    // 已经是网络协议 URL（http/https/data/hclaw-media），直接返回
    if (/^[a-zA-Z][a-zA-Z0-9+\-]*:\/\//.test(normalized)) {
        return normalized
    }

    // Windows 绝对路径: C:\path\to\file
    if (/^[a-zA-Z]:[\\/]/.test(normalized)) {
        return 'hclaw-media:///' + normalized.replace(/\\/g, '/')
    }

    // Unix 绝对路径: /home/user/file
    if (normalized.startsWith('/')) {
        return 'hclaw-media://' + normalized
    }

    // 相对路径（回退）
    return normalized
}

/** 判断 URL 是否为本地协议 */
export function isLocalMediaUrl(url: string): boolean {
    return url.startsWith('hclaw-media://')
}

/**
 * 音频播放器
 * 通过 IPC 读取原始 Buffer → Blob → createObjectURL 生成 blob: URL
 * 无 base64 开销，无协议处理器多次调用问题
 */
const AudioPlayer = memo(function AudioPlayer({url, fileName}: { url: string; fileName?: string }) {
    const audioRef = useRef<HTMLAudioElement>(null)
    const rafRef = useRef<number>(0)
    const blobUrlRef = useRef<string | null>(null)
    const [src, setSrc] = useState('')
    const [playing, setPlaying] = useState(false)
    const [currentTime, setCurrentTime] = useState(0)
    const [duration, setDuration] = useState(0)
    const [volume, setVolume] = useState(1)
    const [loading, setLoading] = useState(true)

    // 加载音频：hclaw-media:// → IPC 读原始 Buffer → Blob URL
    useEffect(() => {
        let cancelled = false

        async function loadAudio() {
            if (!url.startsWith('hclaw-media://')) {
                setSrc(url)
                setLoading(false)
                return
            }
            // 从 URL 提取本地路径
            let filePath = ''
            try {
                // ⚠️ URL.pathname 返回百分号编码形式，必须 decodeURIComponent
                // 否则含空格/中文的路径会找不到文件
                filePath = decodeURIComponent(new URL(url).pathname).replace(/^[/\\]+/, '')
            } catch {
                setSrc(url)
                setLoading(false)
                return
            }
            if (!filePath || !window.electronAPI?.readFileBuffer) {
                setSrc(url)
                setLoading(false)
                return
            }
            try {
                const result = await window.electronAPI.readFileBuffer(filePath)
                if (cancelled) return
                if (result) {
                    const blob = new Blob([result.data as BlobPart], {type: result.mimeType})
                    blobUrlRef.current = URL.createObjectURL(blob)
                    setSrc(blobUrlRef.current)
                } else {
                    setSrc(url) // fallback: 协议处理器
                }
            } catch {
                if (!cancelled) setSrc(url)
            }
            if (!cancelled) setLoading(false)
        }

        loadAudio()
        return () => {
            cancelled = true
        }
    }, [url])

    // 卸载时释放 Blob URL
    useEffect(() => {
        return () => {
            if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current)
        }
    }, [])

    const togglePlay = useCallback(() => {
        const audio = audioRef.current
        if (!audio) return
        if (playing) {
            audio.pause()
        } else {
            audio.play().catch((err) => {
                console.error('[AudioPlayer] play failed:', err)
                setPlaying(false)
            })
        }
        setPlaying(!playing)
    }, [playing])

    // rAF 循环更新进度（60fps）
    useEffect(() => {
        if (!playing) return
        const update = () => {
            const audio = audioRef.current
            if (audio && !audio.paused) {
                setCurrentTime(audio.currentTime)
            }
            rafRef.current = requestAnimationFrame(update)
        }
        rafRef.current = requestAnimationFrame(update)
        return () => cancelAnimationFrame(rafRef.current)
    }, [playing])

    const onLoadedMetadata = useCallback(() => {
        setDuration(audioRef.current?.duration ?? 0)
    }, [])

    const onEnded = useCallback(() => {
        setPlaying(false)
        setCurrentTime(0)
    }, [])

    const onError = useCallback(() => {
        const audio = audioRef.current
        if (!audio) return
        console.error('[AudioPlayer] element error:', {
            src: src || url,
            errorCode: audio.error?.code,
            errorMsg: audio.error?.message,
            networkState: audio.networkState,
            readyState: audio.readyState,
        })
    }, [src, url])

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

    // 加载中：仅显示精简占位（IPC 极快，不会闪烁太久）
    if (loading) {
        return (
            <div className="my-2 p-3 rounded-lg bg-[var(--surface-muted)]/40 border border-[var(--border)]/30">
                {fileName && (
                    <div className="text-xs text-[var(--text-muted)] mb-2 truncate font-mono">{fileName}</div>
                )}
                <div className="flex items-center justify-center py-4">
                    <div
                        className="w-5 h-5 border-2 border-[var(--border)] border-t-pink-500 rounded-full animate-spin"/>
                </div>
            </div>
        )
    }

    return (
        <div className="my-2 p-3 rounded-lg bg-[var(--surface-muted)]/40 border border-[var(--border)]/30">
            <audio
                ref={audioRef}
                src={src}
                onLoadedMetadata={onLoadedMetadata}
                onEnded={onEnded}
                onError={onError}
                preload="auto"
            />

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

/**
 * 视频播放器
 */
const VideoPlayer = memo(function VideoPlayer({url, caption, width, height}: {
    url: string;
    caption?: string;
    width?: number;
    height?: number;
}) {
    return (
        <div className="my-2 rounded-lg overflow-hidden border border-[var(--border)]/30 bg-black/20">
            <video
                controls
                className="w-full max-h-[70vh] object-contain"
                style={{
                    maxWidth: width ? `${width}px` : '100%',
                    aspectRatio: width && height ? `${width}/${height}` : undefined,
                }}
                preload="metadata"
                playsInline
            >
                <source src={url}/>
                您的浏览器不支持视频播放
            </video>
            {caption && (
                <div className="px-3 py-2 text-xs text-[var(--text-muted)] border-t border-[var(--border)]/20">
                    {caption}
                </div>
            )}
        </div>
    )
})

/**
 * 图片渲染
 */
const ImageRenderer = memo(function ImageRenderer({url, caption, width, height}: {
    url: string;
    caption?: string;
    width?: number;
    height?: number;
}) {
    const [showModal, setShowModal] = useState(false)
    const [loaded, setLoaded] = useState(false)
    const [error, setError] = useState(false)

    return (
        <>
            <div className="my-2">
                {/* Loading state */}
                {!loaded && !error && (
                    <div
                        className="flex items-center justify-center h-32 rounded-lg bg-[var(--surface-muted)]/30 border border-[var(--border)]/20">
                        <div
                            className="w-6 h-6 border-2 border-[var(--border)] border-t-[var(--brand-primary)] rounded-full animate-spin"/>
                    </div>
                )}

                {/* Error state */}
                {error && (
                    <div
                        className="flex flex-col items-center justify-center h-32 rounded-lg bg-[var(--surface-muted)]/30 border border-[var(--border)]/20 text-[var(--text-muted)]">
                        <svg className="w-8 h-8 mb-1 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                                  d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"/>
                        </svg>
                        <span className="text-xs">图片加载失败</span>
                    </div>
                )}

                <img
                    src={url}
                    alt={caption || ''}
                    className={`rounded-lg border border-[var(--border)]/20 object-contain cursor-pointer transition-opacity hover:opacity-90 ${loaded ? '' : 'hidden'}`}
                    style={{
                        maxWidth: '100%',
                        maxHeight: width && height ? `${Math.min(height, 600)}px` : '400px',
                        width: width ? `${Math.min(width, 800)}px` : undefined,
                    }}
                    loading="lazy"
                    onClick={() => setShowModal(true)}
                    onLoad={() => setLoaded(true)}
                    onError={() => {
                        setError(true);
                        setLoaded(true)
                    }}
                />

                {caption && loaded && (
                    <div className="mt-1 text-xs text-[var(--text-muted)] text-center">{caption}</div>
                )}
            </div>

            {/* Fullscreen preview modal */}
            {showModal && (
                <ImagePreviewModal
                    src={url}
                    alt={caption || '图片预览'}
                    onClose={() => setShowModal(false)}
                />
            )}
        </>
    )
})

/** 从 URL 提取文件名 */
export function extractFileName(urlOrPath: string): string {
    if (!urlOrPath) return '文件'
    try {
        const parts = urlOrPath.split('/')
        const last = parts[parts.length - 1]?.split('?')[0]
        return last || '文件'
    } catch {
        return '文件'
    }
}

/**
 * 统一媒体播放器
 */
const MediaPlayer = memo(function MediaPlayer({media}: MediaPlayerProps) {
    const {type, url, caption, fileName} = media
    const resolvedUrl = toMediaUrl(url)
    const displayName = fileName || extractFileName(url)

    switch (type) {
        case 'audio':
            return <AudioPlayer url={resolvedUrl} fileName={displayName}/>

        case 'image':
            return <ImageRenderer url={resolvedUrl} caption={caption} width={media.width} height={media.height}/>

        case 'video':
            return <VideoPlayer url={resolvedUrl} caption={caption || displayName} width={media.width}
                                height={media.height}/>

        default:
            return null
    }
})

export default MediaPlayer