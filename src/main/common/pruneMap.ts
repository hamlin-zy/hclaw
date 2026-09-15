/**
 * 缓存 map 裁剪工具（repo / plugin 版本缓存共用）
 *
 * 语义：只删「不在 activeIds 中」的 key —— 现存条目的读取结果不受影响。
 * 先对 keys 取快照再删除，避免迭代中修改 map。
 */
export function pruneMap<K, V>(map: Map<K, V>, activeIds: Iterable<K>): void {
    const keep = new Set(activeIds)
    for (const key of [...map.keys()]) {
        if (!keep.has(key)) map.delete(key)
    }
}
