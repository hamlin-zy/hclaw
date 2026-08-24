// tests/diag/growthDetector.ts — GC 后堆采样序列的线性趋势拟合
export interface GrowthVerdict {
    slopePerRound: number
    r2: number
    leaked: boolean
}

const MIN_SAMPLES = 10
const LEAK_SLOPE_BYTES = 1024
const LEAK_R2 = 0.9

/** 最小二乘：samples 对轮次 index 回归；leaked 判定见 LEAK_* 常量 */
export function detectGrowthTrend(samples: number[]): GrowthVerdict {
    const n = samples?.length ?? 0
    if (n < MIN_SAMPLES) return {slopePerRound: 0, r2: 0, leaked: false}
    let sx = 0, sy = 0, sxy = 0, sxx = 0
    for (let i = 0; i < n; i++) {
        sx += i; sy += samples[i]; sxy += i * samples[i]; sxx += i * i
    }
    const denom = n * sxx - sx * sx
    const slope = denom === 0 ? 0 : (n * sxy - sx * sy) / denom
    const intercept = (sy - slope * sx) / n
    let ssRes = 0, ssTot = 0
    const meanY = sy / n
    for (let i = 0; i < n; i++) {
        ssRes += (samples[i] - (slope * i + intercept)) ** 2
        ssTot += (samples[i] - meanY) ** 2
    }
    const r2 = ssTot === 0 ? 1 : 1 - ssRes / ssTot
    return {slopePerRound: slope, r2, leaked: slope > LEAK_SLOPE_BYTES && r2 > LEAK_R2}
}
