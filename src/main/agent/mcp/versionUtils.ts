/**
 * Version parsing utilities for MCP version management.
 * All functions are pure — no side effects, no I/O.
 */

export type SourceType = 'npx' | 'plugin' | 'binary' | 'url' | 'unknown'
export type PackageManager = 'npm' | 'pip'

export interface VersionMeta {
  current: string | null
  latest: string | null
  hasUpdate: boolean | null
  sourceType: SourceType
  lastChecked: number
  availableVersions?: string[]
  // For binary servers whose binary resolves to a known npm/pip package:
  // when set, the server is upgradable via that package manager.
  pkgName?: string
  pkgManager?: PackageManager
  // For pip-managed servers: the python executable used for detection, so
  // installs use the same environment (`python -m pip` vs bare `pip`).
  pythonCmd?: string
}

/** Remove leading v/V prefix and trim whitespace */
export function stripV(s: string): string {
  return s.replace(/^v/i, '').trim()
}

/** npx/npm 侧不作为包名消费的 CLI flags（parseNpmPackage / parseNpmPackageSpec / buildNpxVersionArgs 共用） */
const NPM_SKIP_FLAGS: ReadonlySet<string> = new Set(['-y', '--yes', '-p', '--package', '--', '--quiet', '--silent'])

/** npm exec/run 子命令 token 需要跳过时返回起始下标 1，否则 0 */
function argsStartIndex(command: string, args: string[]): number {
  const isNpm = command.endsWith('npm')
  if (isNpm && args.length > 0 && (args[0] === 'exec' || args[0] === 'run')) return 1
  return 0
}

/**
 * 返回第一个非 flag 参数（跳过 NPM_SKIP_FLAGS 与以 '-' 开头的 token）。
 * 无匹配返回 null。
 */
function firstNonFlagArg(args: string[], startIndex = 0): string | null {
  for (let i = startIndex; i < args.length; i++) {
    const arg = args[i]
    if (NPM_SKIP_FLAGS.has(arg)) continue
    if (arg.startsWith('-')) continue
    return arg
  }
  return null
}

/**
 * Parse npm package name from npx/npm command + args.
 * Handles: @scope/pkg@version, pkg@latest, -y/-p/--yes flags, npm exec/run.
 * Returns null if no package name can be extracted.
 */
export function parseNpmPackage(command: string, args: string[]): string | null {
  // 注意：不能直接复用 firstNonFlagArg —— stripped 为空时需继续向后搜索，
  // 语义与 parseNpmPackageSpec 的"取第一个非 flag 参数"不同。
  for (let i = argsStartIndex(command, args); i < args.length; i++) {
    const arg = args[i]
    if (NPM_SKIP_FLAGS.has(arg)) continue
    if (arg.startsWith('-')) continue

    // Found the first non-flag argument — this should be the package name
    // Strip @version or @latest suffix
    const stripped = arg.replace(/@[^/@]*$/, '')
    if (stripped) return stripped
  }

  return null
}

/**
 * Compare two version strings with v-prefix normalization.
 * Returns true if they differ (has update), false if equal, null if either is null.
 * String comparison — NOT semver.
 */
export function compareVersions(current: string | null, latest: string | null): boolean | null {
  if (current === null || latest === null) return null
  return stripV(current) !== stripV(latest)
}

/**
 * Validate a version specifier for safe shell embedding.
 * Allows: digits, dots, hyphens, underscores, plus (for build metadata),
 * and optional leading v/V. Rejects shell metacharacters (& | ; $ ` < > etc).
 *
 * Not a full semver validator — just a whitelist for shell safety.
 */
export function isValidVersionSpec(version: string): boolean {
  return /^[vV]?[A-Za-z0-9][A-Za-z0-9._+~-]*$/.test(version)
}

/**
 * Ascending comparator for version strings. Handles numeric segments properly
 * (so 0.0.10 sorts after 0.0.2, unlike naive string sort). Used for ordering
 * `availableVersions` arrays so dropdowns don't look jumbled.
 *
 * Not a full semver implementation — handles pre-release/build suffixes by
 * falling back to string comparison of that segment.
 */
export function compareVersionAsc(a: string, b: string): number {
  const na = stripV(a).split('-')[0].split('+')[0].split('.')
  const nb = stripV(b).split('-')[0].split('+')[0].split('.')
  const len = Math.max(na.length, nb.length)
  for (let i = 0; i < len; i++) {
    const sa = na[i] || '0'
    const sb = nb[i] || '0'
    const an = Number(sa)
    const bn = Number(sb)
    if (!isNaN(an) && !isNaN(bn)) {
      if (an !== bn) return an - bn
    } else {
      if (sa !== sb) return sa < sb ? -1 : 1
    }
  }
  // Same numeric prefix — tie-break by full string (handles pre-release ordering)
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * Parse --version command output to extract a version string.
 * Strategy: regex for first \d+\.\d+\.\d+ pattern, fallback to first line trim, then null.
 */
export function parseVersionOutput(stdout: string): string | null {
  const trimmed = stdout.trim()
  if (!trimmed) return null

  // Try semver-like pattern first (includes pre-release/build metadata)
  const match = trimmed.match(/\d+\.\d+\.\d+[^\s]*/)
  if (match) return match[0]

  // Fallback: first non-empty line
  const firstLine = trimmed.split('\n')[0]?.trim()
  if (firstLine) return firstLine

  return null
}

/**
 * Parse npm package name + pinned version from npx/npm command + args.
 * Handles: @scope/pkg@version, pkg@latest, -y/-p/--yes flags.
 * Returns {pkgName: '', version: null} if no package found.
 * Returns {pkgName, version: null} if package has no version pin or @latest.
 */
export function parseNpmPackageSpec(command: string, args: string[]): {pkgName: string, version: string | null} {
  const arg = firstNonFlagArg(args, argsStartIndex(command, args))
  if (arg) {
    // Found the first non-flag argument — this is the package spec
    // Handle @scope/pkg@version and pkg@version
    // For scoped packages: @scope/pkg@1.2.3 → pkgName=@scope/pkg, version=1.2.3
    // For unscoped: pkg@1.2.3 → pkgName=pkg, version=1.2.3
    // @latest is treated as no pin (npx fetches latest)
    const lastAtIndex = arg.lastIndexOf('@')
    if (lastAtIndex > 0) {
      // Has version suffix (lastAtIndex > 0 ensures scope @ is not the version @)
      const pkgName = arg.substring(0, lastAtIndex)
      const version = arg.substring(lastAtIndex + 1)
      if (version && version !== 'latest') {
        return {pkgName, version}
      }
      return {pkgName, version: null}
    }
    // No version suffix
    return {pkgName: arg, version: null}
  }

  return {pkgName: '', version: null}
}

/**
 * Build a new args array with the package spec replaced to pin a target version.
 * Finds the first arg that matches pkgName (with or without @version suffix)
 * and replaces it with `pkgName@targetVersion`.
 * Throws if the package is not found in args.
 */
export function buildNpxVersionArgs(args: string[], pkgName: string, targetVersion: string): string[] {
  const result = [...args]

  for (let i = 0; i < result.length; i++) {
    const arg = result[i]
    if (NPM_SKIP_FLAGS.has(arg)) continue
    if (arg.startsWith('-')) continue

    // Check if this arg is the package spec (with or without version)
    if (arg === pkgName || arg.startsWith(pkgName + '@')) {
      result[i] = `${pkgName}@${targetVersion}`
      return result
    }
    // If not the package, stop searching (first non-flag arg is the package)
    break
  }

  throw new Error(`Package ${pkgName} not found in args`)
}

/**
 * Parse checkUrl response body to extract latest version.
 * Priority: JSON tag_name (stripV) → JSON version field → regex semver match.
 */
export function parseCheckUrlResponse(body: string): string | null {
  const trimmed = body.trim()
  if (!trimmed) return null

  // Try JSON parsing
  try {
    const json = JSON.parse(trimmed)

    // Priority 1: GitHub releases API tag_name
    if (typeof json.tag_name === 'string' && json.tag_name) {
      return stripV(json.tag_name)
    }

    // Priority 2: custom version field
    if (typeof json.version === 'string' && json.version) {
      return stripV(json.version)
    }
  } catch {
    // Not JSON, fall through to regex
  }

  // Priority 3: regex match for semver-like pattern
  const match = trimmed.match(/\d+\.\d+\.\d+[^\s]*/)
  if (match) return match[0]

  return null
}
