import {describe, expect, it} from 'vitest'
import {
  parseNpmPackage,
  parseNpmPackageSpec,
  compareVersions,
  parseVersionOutput,
  parseCheckUrlResponse,
  stripV,
} from '@/main/agent/mcp/versionUtils'

describe('stripV', () => {
  it('removes leading v prefix', () => {
    expect(stripV('v1.2.3')).toBe('1.2.3')
    expect(stripV('V1.2.3')).toBe('1.2.3')
    expect(stripV('1.2.3')).toBe('1.2.3')
    expect(stripV('')).toBe('')
  })
})

describe('parseNpmPackage', () => {
  it('extracts simple package name', () => {
    expect(parseNpmPackage('npx', ['@modelcontextprotocol/server-filesystem'])).toBe('@modelcontextprotocol/server-filesystem')
  })

  it('extracts scoped package with version', () => {
    expect(parseNpmPackage('npx', ['@scope/pkg@1.2.0'])).toBe('@scope/pkg')
  })

  it('extracts scoped package with @latest', () => {
    expect(parseNpmPackage('npx', ['@scope/pkg@latest'])).toBe('@scope/pkg')
  })

  it('extracts non-scoped package with version', () => {
    expect(parseNpmPackage('npx', ['pkg@1.2.0'])).toBe('pkg')
  })

  it('extracts non-scoped package with @latest', () => {
    expect(parseNpmPackage('npx', ['pkg@latest'])).toBe('pkg')
  })

  it('skips npx flags -y / -p / --yes', () => {
    expect(parseNpmPackage('npx', ['-y', 'pkg'])).toBe('pkg')
    expect(parseNpmPackage('npx', ['--yes', 'pkg'])).toBe('pkg')
    expect(parseNpmPackage('npx', ['-p', 'pkg'])).toBe('pkg')
  })

  it('skips multiple flags before package name', () => {
    expect(parseNpmPackage('npx', ['-y', '-p', 'pkg'])).toBe('pkg')
  })

  it('returns null for empty args', () => {
    expect(parseNpmPackage('npx', [])).toBeNull()
  })

  it('returns null for args with only flags', () => {
    expect(parseNpmPackage('npx', ['-y'])).toBeNull()
  })

  it('works with full path npx command', () => {
    expect(parseNpmPackage('/usr/local/bin/npx', ['pkg'])).toBe('pkg')
  })

  it('works with npm command', () => {
    expect(parseNpmPackage('npm', ['exec', 'pkg'])).toBe('pkg')
  })

  it('skips npm exec / run flags', () => {
    expect(parseNpmPackage('npm', ['exec', '--', 'pkg'])).toBe('pkg')
    expect(parseNpmPackage('npm', ['run', 'pkg'])).toBe('pkg')
  })
})

describe('compareVersions', () => {
  it('returns false when current equals latest', () => {
    expect(compareVersions('1.2.3', '1.2.3')).toBe(false)
  })

  it('returns true when current differs from latest', () => {
    expect(compareVersions('1.2.3', '1.3.0')).toBe(true)
  })

  it('normalizes v prefix', () => {
    expect(compareVersions('v1.2.3', '1.2.3')).toBe(false)
    expect(compareVersions('1.2.3', 'v1.2.3')).toBe(false)
  })

  it('trims whitespace', () => {
    expect(compareVersions('  1.2.3  ', ' 1.2.3 ')).toBe(false)
  })

  it('returns null when current is null', () => {
    expect(compareVersions(null, '1.2.3')).toBeNull()
  })

  it('returns null when latest is null', () => {
    expect(compareVersions('1.2.3', null)).toBeNull()
  })

  it('returns null when both are null', () => {
    expect(compareVersions(null, null)).toBeNull()
  })
})

describe('parseVersionOutput', () => {
  it('extracts simple version', () => {
    expect(parseVersionOutput('1.2.3\n')).toBe('1.2.3')
  })

  it('extracts from "pkg v1.2.3" format', () => {
    expect(parseVersionOutput('my-package v1.2.3\n')).toBe('1.2.3')
  })

  it('extracts first semver from multi-line output', () => {
    expect(parseVersionOutput('Loading...\nVersion: 1.2.3\nBuild: 456\n')).toBe('1.2.3')
  })

  it('falls back to first line trim when no semver pattern', () => {
    expect(parseVersionOutput('custom-version-string\n')).toBe('custom-version-string')
  })

  it('returns null for empty output', () => {
    expect(parseVersionOutput('')).toBeNull()
  })

  it('returns null for whitespace-only output', () => {
    expect(parseVersionOutput('   \n  \n')).toBeNull()
  })

  it('extracts from "1.2.3-beta+build" format', () => {
    expect(parseVersionOutput('1.2.3-beta+build\n')).toBe('1.2.3-beta+build')
  })
})

describe('parseCheckUrlResponse', () => {
  it('parses GitHub releases API tag_name', () => {
    const body = JSON.stringify({tag_name: 'v2.0.0', name: 'Release 2.0.0'})
    expect(parseCheckUrlResponse(body)).toBe('2.0.0')
  })

  it('parses custom JSON version field', () => {
    const body = JSON.stringify({version: '3.1.0'})
    expect(parseCheckUrlResponse(body)).toBe('3.1.0')
  })

  it('falls back to regex match when no known fields', () => {
    const body = 'Some text with version 4.5.6 embedded'
    expect(parseCheckUrlResponse(body)).toBe('4.5.6')
  })

  it('returns null when no version found', () => {
    expect(parseCheckUrlResponse('no version here')).toBeNull()
  })

  it('returns null for empty body', () => {
    expect(parseCheckUrlResponse('')).toBeNull()
  })

  it('prefers tag_name over version field', () => {
    const body = JSON.stringify({tag_name: 'v1.0.0', version: '0.9.0'})
    expect(parseCheckUrlResponse(body)).toBe('1.0.0')
  })
})

describe('parseNpmPackageSpec', () => {
  it('extracts pinned version from scoped package', () => {
    const result = parseNpmPackageSpec('npx', ['-y', '@upstash/context7-mcp@2.1.4', '--api-key', 'xxx'])
    expect(result).toEqual({pkgName: '@upstash/context7-mcp', version: '2.1.4'})
  })

  it('returns null version for unpinned package', () => {
    const result = parseNpmPackageSpec('npx', ['-y', '@upstash/context7-mcp', '--api-key', 'xxx'])
    expect(result).toEqual({pkgName: '@upstash/context7-mcp', version: null})
  })

  it('returns null version for @latest pin', () => {
    const result = parseNpmPackageSpec('npx', ['-y', '@modelcontextprotocol/server-github@latest'])
    expect(result).toEqual({pkgName: '@modelcontextprotocol/server-github', version: null})
  })

  it('extracts pinned version from unscoped package', () => {
    const result = parseNpmPackageSpec('npx', ['-y', 'aigroup-mdtoword-mcp@1.0.0'])
    expect(result).toEqual({pkgName: 'aigroup-mdtoword-mcp', version: '1.0.0'})
  })

  it('returns null for no package found', () => {
    const result = parseNpmPackageSpec('npx', ['-y'])
    expect(result).toEqual({pkgName: '', version: null})
  })
})
