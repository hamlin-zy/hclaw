// src/main/project-manager/git/numstat.ts

/**
 * 聚合 `git diff --numstat` 输出为 additions/deletions。
 *
 * 行格式：`<add>\t<del>\t<path>`，二进制文件为 `-\t-\t<path>`。
 *
 * 语义（与改造前 status.ts / diff.ts 内联循环逐条等价，勿"顺手修正"）：
 * - 空串 / 空行：`''.split('\t')` 得 `['']`，add 为空串（假值）跳过；del 为 undefined 跳过。
 * - 数字解析保持 `parseInt` 语义：非数字得到 NaN（既是既有行为，也不得改成 Number/isNaN 校验）。
 * - 列数异常时以 `[add, del]` 前两列为准（与解构赋值一致）。
 */
export function parseNumstat(raw: string): {additions: number, deletions: number} {
  let additions = 0
  let deletions = 0
  for (const line of raw.split('\n')) {
    const [add, del] = line.split('\t')
    if (add && add !== '-') additions += parseInt(add, 10)
    if (del && del !== '-') deletions += parseInt(del, 10)
  }
  return {additions, deletions}
}
