/** 行号数组 → 压缩范围字符串。[12,13,14,18] → "12-14,18"；[12] → "12"；[] → "" */
export function formatLineRanges(nums: number[]): string {
  const sorted = [...new Set(nums.filter(n => Number.isInteger(n)))].sort((a, b) => a - b)
  const parts: string[] = []
  let i = 0
  while (i < sorted.length) {
    let j = i
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++
    parts.push(i === j ? `${sorted[i]}` : `${sorted[i]}-${sorted[j]}`)
    i = j + 1
  }
  return parts.join(',')
}
