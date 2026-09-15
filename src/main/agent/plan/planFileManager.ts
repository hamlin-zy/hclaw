/**
 * Plan 文件管理器
 *
 * 负责 PLAN.md 文件的读写、存在性检查和外部编辑器打开等操作。
 * 支持项目本地 .hclaw/PLAN.md 和用户主目录 ~/.hclaw/PLAN.md 两种路径。
 *
 * 简化：提取 tryCatch 工具消除 6 个方法中重复的 try-catch 结构
 */

import * as fs from 'fs'
import * as path from 'path'
import {spawn} from 'child_process'
import {getHclawDir} from '../../config'

// ─── 常量 ──────────────────────────────────────────────

const PLAN_FILENAME = 'PLAN.md'
const USER_PLAN_PATH = path.join(getHclawDir(), PLAN_FILENAME)

// ─── 类型定义 ──────────────────────────────────────────

export type EditorType =
    | 'code' | 'vim' | 'vi' | 'nano' | 'subl' | 'atom'
    | 'code-insiders' | 'webstorm' | 'phpstorm' | 'intellij' | 'auto'

export interface PlanReadResult {
  success: true;
  content: string;
  filePath: string
}

export interface PlanReadError {
  success: false;
  error: string
}

export interface PlanWriteResult {
  success: true;
  filePath: string
}

export interface PlanWriteError {
  success: false;
  error: string
}

export interface EditorOpenResult {
  success: true;
  editor: string;
  pid?: number
}

export interface EditorOpenError {
  success: false;
  error: string
}

// ─── tryCatch 工具 ─────────────────────────────────────

type Result<T extends Record<string, unknown>> = ({ success: true } & T) | { success: false; error: string }

function asError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function tryCatch<T extends Record<string, unknown>>(fn: () => T, prefix: string): Result<T> {
  try {
    return {success: true, ...fn()}
  } catch (error) {
    return {success: false, error: `${prefix}: ${asError(error)}`}
  }
}

// ─── PlanFileManager 类 ─────────────────────────────────

export class PlanFileManager {
  private workingDir: string

  constructor(workingDir: string = process.cwd()) {
    this.workingDir = workingDir
  }

  getPlanFilePath(): string {
    const localPlanPath = this.getLocalPlanPath()
    return fs.existsSync(localPlanPath) ? localPlanPath : USER_PLAN_PATH
  }

  getLocalPlanPath(): string {
      return path.join(this.workingDir, '.hclaw', PLAN_FILENAME)
  }

  readPlan(): PlanReadResult | PlanReadError {
    return tryCatch(() => {
      const filePath = this.getPlanFilePath()
      if (!fs.existsSync(filePath)) throw new Error(`Plan 文件不存在: ${filePath}`)
      return {content: fs.readFileSync(filePath, 'utf-8'), filePath}
    }, '读取失败') as PlanReadResult | PlanReadError
  }

  writePlan(content: string, useLocalPath = true): PlanWriteResult | PlanWriteError {
    return tryCatch(() => {
      const filePath = useLocalPath ? this.getLocalPlanPath() : USER_PLAN_PATH
      const dir = path.dirname(filePath)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, {recursive: true})
      fs.writeFileSync(filePath, content, 'utf-8')
      return {filePath}
    }, '写入失败') as PlanWriteResult | PlanWriteError
  }

  planExists(checkLocalOnly = false): boolean {
    return checkLocalOnly
        ? fs.existsSync(this.getLocalPlanPath())
        : fs.existsSync(this.getLocalPlanPath()) || fs.existsSync(USER_PLAN_PATH)
  }

  openInEditor(editor: EditorType = 'auto'): EditorOpenResult | EditorOpenError {
    return tryCatch(() => {
      const filePath = this.getPlanFilePath()
      if (!fs.existsSync(filePath)) {
        const dir = path.dirname(filePath)
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, {recursive: true})
        fs.writeFileSync(filePath, '', 'utf-8')
      }
      const editorCommand = resolveEditorCommand(editor)
      if (!editorCommand) throw new Error('无法确定编辑器命令')
      const proc = spawn(editorCommand, [filePath], {detached: true, stdio: 'ignore', windowsHide: true, shell: process.platform === 'win32'})
      proc.unref()
      return {editor: editorCommand, pid: proc.pid}
    }, '启动编辑器失败') as EditorOpenResult | EditorOpenError
  }

  deletePlan(deleteLocalOnly = false): { success: boolean; error?: string } {
    return tryCatch(() => {
      const localPath = this.getLocalPlanPath()
      const userPath = USER_PLAN_PATH
      let deleted = false
      if (fs.existsSync(localPath)) {
        fs.unlinkSync(localPath);
        deleted = true
      }
      if (!deleteLocalOnly && fs.existsSync(userPath)) {
        fs.unlinkSync(userPath);
        deleted = true
      }
      if (!deleted) throw new Error('Plan 文件不存在，无需删除')
      return {}
    }, '删除失败') as { success: boolean; error?: string }
  }
}

// ─── 编辑器命令解析 ─────────────────────────────────────

/** `auto` 的确定性回退编辑器（Windows 下经 shell 启动，见 openInEditor 的 shell 选项） */
const AUTO_EDITOR: EditorType = 'code'

/**
 * 解析编辑器命令（纯函数：不查 PATH、不 spawn 进程）。
 *
 * `auto` 恒为 `code`——这与旧实现**实际行为**完全一致，只是不再假装探测：
 * 旧实现对候选列表逐个 `spawn(ed, ['--version'])` 并在同步 try/catch 里判断“是否抛错”，
 * 但 spawn 对 ENOENT 只会**异步** emit('error')、不抛同步异常，故 try/catch 永不触发、
 * 循环恒在首项 `code` 处返回（`auto ≡ code`）。同时那个进程还带一个空 error 监听，
 * 专门吞掉“编辑器不存在”的 ENOENT，使死探测更难被发现。
 *
 * 收敛方式的选择依据：探测要真正生效必须改为异步（spawn + 'error'/'spawn' 事件），
 * 那会改变 openInEditor 的同步返回契约（返回值形状不可变，约束 A），故此处只做等价的
 * 确定性收敛：删掉不可达候选列表与随之而来的空 error 监听。
 */
export function resolveEditorCommand(editor: EditorType): string | null {
  return editor === 'auto' ? AUTO_EDITOR : editor
}

// ─── 快捷工厂 ──────────────────────────────────────────

export function createPlanFileManager(workingDir?: string): PlanFileManager {
  return new PlanFileManager(workingDir)
}
export function readPlan(workingDir?: string): PlanReadResult | PlanReadError {
  return new PlanFileManager(workingDir).readPlan()
}

export function writePlan(content: string, workingDir?: string, useLocalPath?: boolean): PlanWriteResult | PlanWriteError {
  return new PlanFileManager(workingDir).writePlan(content, useLocalPath)
}

export function planExists(workingDir?: string, checkLocalOnly?: boolean): boolean {
  return new PlanFileManager(workingDir).planExists(checkLocalOnly)
}

export function deletePlan(workingDir?: string, deleteLocalOnly?: boolean): { success: boolean; error?: string } {
  return new PlanFileManager(workingDir).deletePlan(deleteLocalOnly)
}
