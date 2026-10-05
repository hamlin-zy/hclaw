/**
 * 流式重复检测器 — 在单次 LLM 请求的流式输出中检测重复循环。
 *
 * 原理：每累积 checkInterval 个新字符，取缓冲区末尾 shingleSize 字符
 * 作为"探针"，在整个 buffer 中搜索出现次数。出现 ≥ threshold 次 → 判定循环。
 *
 * 与固定位置 shingling 不同，此方法不依赖采样位置与循环周期的对齐——
 * 探针始终是"当前末尾"，全文搜索自然覆盖所有偏移。
 *
 * 性能：每次检查 = 1 次 indexOf 扫描（O(buffer 长度)），检查频率 =
 * 每 checkInterval 字符一次。一轮 2000 字符输出约 33 次检查，总计 ~6 万次
 * 字符比较，微秒级。
 */

export interface RepetitionDetectorOptions {
    /** 探针窗口大小（字符）。默认 120，下限 50 */
    shingleSize: number
    /** 探针在全文出现 N 次触发。默认 3，下限 2 */
    threshold: number
    /** 每累积 N 新字符检查一次。默认 60，下限 20 */
    checkInterval: number
}

/** 钳制参数到下限，避免不合理配置 */
function clampOptions(opts: RepetitionDetectorOptions): RepetitionDetectorOptions {
    return {
        shingleSize: Math.max(50, opts.shingleSize),
        threshold: Math.max(2, opts.threshold),
        checkInterval: Math.max(20, opts.checkInterval),
    }
}

export class StreamRepetitionDetector {
    private readonly opts: RepetitionDetectorOptions
    private buffer = ''
    private lastCheck = 0
    private detected = false
    /** 首次出现探针的起始位置（截断保留到此位置 + shingleSize） */
    private firstRepeatStart = -1

    constructor(opts: Partial<RepetitionDetectorOptions> = {}) {
        this.opts = clampOptions({
            shingleSize: opts.shingleSize ?? 120,
            threshold: opts.threshold ?? 3,
            checkInterval: opts.checkInterval ?? 60,
        })
    }

    /** 追加流式文本，内部按 checkInterval 频率检查重复 */
    append(text: string): void {
        if (this.detected || !text) return
        this.buffer += text
        while (this.buffer.length - this.lastCheck >= this.opts.checkInterval) {
            this.lastCheck += this.opts.checkInterval
            if (this.buffer.length < this.opts.shingleSize) continue
            // 取末尾 shingleSize 字符作为探针
            const probe = this.buffer.slice(this.buffer.length - this.opts.shingleSize)
            const count = this.countOccurrences(probe)
            if (count >= this.opts.threshold) {
                this.detected = true
                this.firstRepeatStart = this.buffer.indexOf(probe)
                return
            }
        }
    }

    get isDetected(): boolean { return this.detected }

    /**
     * 截断：保留到首次探针出现结束（保留一份完整内容，丢弃后续重复）。
     * 未触发时返回完整 buffer。
     */
    getTruncatedContent(): string {
        if (!this.detected || this.firstRepeatStart < 0) return this.buffer
        return this.buffer.slice(0, this.firstRepeatStart + this.opts.shingleSize)
    }

    /** 在整个 buffer 中计数 probe 出现次数（允许重叠匹配） */
    private countOccurrences(probe: string): number {
        let count = 0
        let pos = 0
        while ((pos = this.buffer.indexOf(probe, pos)) !== -1) {
            count++
            pos += 1
        }
        return count
    }
}
