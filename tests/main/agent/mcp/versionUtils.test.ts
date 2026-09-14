import {describe, expect, it} from 'vitest'
import {
  parseNpmPackageSpec,
  compareVersions,
  parseVersionOutput,
  stripV,
  isValidVersionSpec,
  compareVersionAsc,
} from '@/main/agent/mcp/versionUtils'

describe('stripV', () => {
  it('removes leading v prefix', () => {
    expect(stripV('v1.2.3')).toBe('1.2.3')
    expect(stripV('V1.2.3')).toBe('1.2.3')
    expect(stripV('1.2.3')).toBe('1.2.3')
    expect(stripV('')).toBe('')
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

describe('isValidVersionSpec', () => {
  it('accepts plain and v-prefixed version specs', () => {
    expect(isValidVersionSpec('1.2.3')).toBe(true)
    expect(isValidVersionSpec('v1.2.3')).toBe(true)
    expect(isValidVersionSpec('1.2.3-beta+build')).toBe(true)
  })

  it('rejects specs containing shell metacharacters', () => {
    expect(isValidVersionSpec('1.2.3; rm -rf /')).toBe(false)
    expect(isValidVersionSpec('1.2.3 && echo pwned')).toBe(false)
    expect(isValidVersionSpec('1.2.3|cat')).toBe(false)
    expect(isValidVersionSpec('$(whoami)')).toBe(false)
    expect(isValidVersionSpec('`id`')).toBe(false)
    expect(isValidVersionSpec('1.2.3>out')).toBe(false)
  })
})

describe('compareVersionAsc', () => {
  it('orders numeric segments numerically, not lexicographically', () => {
    expect(compareVersionAsc('0.0.10', '0.0.2')).toBeGreaterThan(0)
    expect(compareVersionAsc('0.0.2', '0.0.10')).toBeLessThan(0)
    expect(compareVersionAsc('0.2.0', '0.10.0')).toBeLessThan(0)
  })

  it('returns 0 for equal versions', () => {
    expect(compareVersionAsc('1.2.3', '1.2.3')).toBe(0)
    expect(compareVersionAsc('1.2.3', 'v1.2.4')).toBeLessThan(0)
  })

  it('sorts a version list ascending', () => {
    const sorted = ['0.0.10', '0.0.2', '0.1.0', '0.0.1'].sort(compareVersionAsc)
    expect(sorted).toEqual(['0.0.1', '0.0.2', '0.0.10', '0.1.0'])
  })
})
