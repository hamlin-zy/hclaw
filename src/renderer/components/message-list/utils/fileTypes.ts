/**
 * 文件类型配置
 */

export interface FileTypeConfig {
    letter: string
    bgColor: string
    textColor: string
}

/**
 * 文件类型首字母和对应颜色配置
 */
export const FILE_TYPE_CONFIG: Record<string, FileTypeConfig> = {
    // 图片
    '.jpg': {letter: 'J', bgColor: 'bg-pink-500', textColor: 'text-white'},
    '.jpeg': {letter: 'J', bgColor: 'bg-pink-500', textColor: 'text-white'},
    '.png': {letter: 'P', bgColor: 'bg-blue-500', textColor: 'text-white'},
    '.gif': {letter: 'G', bgColor: 'bg-purple-500', textColor: 'text-white'},
    '.webp': {letter: 'W', bgColor: 'bg-cyan-500', textColor: 'text-white'},
    '.svg': {letter: 'S', bgColor: 'bg-orange-500', textColor: 'text-white'},
    '.bmp': {letter: 'B', bgColor: 'bg-red-500', textColor: 'text-white'},
    // 文档
    '.pdf': {letter: 'P', bgColor: 'bg-red-600', textColor: 'text-white'},
    '.doc': {letter: 'D', bgColor: 'bg-blue-600', textColor: 'text-white'},
    '.docx': {letter: 'D', bgColor: 'bg-blue-600', textColor: 'text-white'},
    '.txt': {letter: 'T', bgColor: 'bg-gray-500', textColor: 'text-white'},
    '.md': {letter: 'M', bgColor: 'bg-slate-600', textColor: 'text-white'},
    '.rtf': {letter: 'R', bgColor: 'bg-gray-600', textColor: 'text-white'},
    // 表格
    '.xls': {letter: 'X', bgColor: 'bg-green-600', textColor: 'text-white'},
    '.xlsx': {letter: 'X', bgColor: 'bg-green-600', textColor: 'text-white'},
    '.csv': {letter: 'C', bgColor: 'bg-emerald-500', textColor: 'text-white'},
    // 演示
    '.ppt': {letter: 'P', bgColor: 'bg-orange-600', textColor: 'text-white'},
    '.pptx': {letter: 'P', bgColor: 'bg-orange-600', textColor: 'text-white'},
    // 代码
    '.js': {letter: 'J', bgColor: 'bg-yellow-500', textColor: 'text-black'},
    '.ts': {letter: 'T', bgColor: 'bg-blue-600', textColor: 'text-white'},
    '.py': {letter: 'P', bgColor: 'bg-green-500', textColor: 'text-white'},
    '.java': {letter: 'J', bgColor: 'bg-red-500', textColor: 'text-white'},
    '.cpp': {letter: 'C', bgColor: 'bg-blue-500', textColor: 'text-white'},
    '.c': {letter: 'C', bgColor: 'bg-blue-500', textColor: 'text-white'},
    '.html': {letter: 'H', bgColor: 'bg-orange-500', textColor: 'text-white'},
    '.css': {letter: 'C', bgColor: 'bg-indigo-500', textColor: 'text-white'},
    '.json': {letter: 'J', bgColor: 'bg-amber-500', textColor: 'text-black'},
    '.xml': {letter: 'X', bgColor: 'bg-orange-600', textColor: 'text-white'},
    '.yaml': {letter: 'Y', bgColor: 'bg-pink-500', textColor: 'text-white'},
    '.yml': {letter: 'Y', bgColor: 'bg-pink-500', textColor: 'text-white'},
    // 压缩
    '.zip': {letter: 'Z', bgColor: 'bg-yellow-600', textColor: 'text-white'},
    '.rar': {letter: 'R', bgColor: 'bg-purple-600', textColor: 'text-white'},
    '.7z': {letter: '7', bgColor: 'bg-gray-600', textColor: 'text-white'},
    '.tar': {letter: 'T', bgColor: 'bg-brown-500', textColor: 'text-white'},
    '.gz': {letter: 'G', bgColor: 'bg-amber-600', textColor: 'text-white'},
    // 音视频
    '.mp3': {letter: 'A', bgColor: 'bg-pink-500', textColor: 'text-white'},
    '.mp4': {letter: 'V', bgColor: 'bg-purple-600', textColor: 'text-white'},
    '.avi': {letter: 'V', bgColor: 'bg-indigo-600', textColor: 'text-white'},
    '.mov': {letter: 'V', bgColor: 'bg-teal-600', textColor: 'text-white'},
    '.wav': {letter: 'A', bgColor: 'bg-cyan-500', textColor: 'text-white'},
    '.flac': {letter: 'A', bgColor: 'bg-emerald-600', textColor: 'text-white'},
    // 其他
    '.exe': {letter: 'E', bgColor: 'bg-red-700', textColor: 'text-white'},
    '.dll': {letter: 'D', bgColor: 'bg-blue-700', textColor: 'text-white'},
    '.iso': {letter: 'I', bgColor: 'bg-gray-700', textColor: 'text-white'},
    '.jar': {letter: 'J', bgColor: 'bg-orange-700', textColor: 'text-white'},
}

/**
 * 根据文件扩展名获取首字母配置
 */
export function getFileTypeConfig(fileName: string): FileTypeConfig {
    const ext = '.' + fileName.split('.').pop()?.toLowerCase()
    return FILE_TYPE_CONFIG[ext] || {
        letter: ext[1]?.toUpperCase() || 'F',
        bgColor: 'bg-gray-500',
        textColor: 'text-white'
    }
}

/**
 * 格式化文件大小
 */
export function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
