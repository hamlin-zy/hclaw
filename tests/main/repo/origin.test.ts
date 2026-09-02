// tests/main/repo/origin.test.ts
import {describe, expect, it} from 'vitest'
import {parseGitOrigin, parseCloneUrl, repoDirName} from '@/main/repo/origin'

describe('parseGitOrigin', () => {
  it('解析 https github origin', () => {
    expect(parseGitOrigin('https://github.com/greensock/gsap-skills.git'))
      .toEqual({owner: 'greensock', name: 'gsap-skills', source: 'github'})
  })
  it('解析无 .git 的 https github', () => {
    expect(parseGitOrigin('https://github.com/obra/superpowers'))
      .toEqual({owner: 'obra', name: 'superpowers', source: 'github'})
  })
  it('解析 SSH github origin', () => {
    expect(parseGitOrigin('git@github.com:greensock/gsap-skills.git'))
      .toEqual({owner: 'greensock', name: 'gsap-skills', source: 'github'})
  })
  it('解析 gitee / gitlab', () => {
    expect(parseGitOrigin('https://gitee.com/user/repo.git')?.source).toBe('gitee')
    expect(parseGitOrigin('https://gitlab.com/user/repo.git')?.source).toBe('gitlab')
  })
  it('非法 URL → null', () => {
    expect(parseGitOrigin('not-a-url')).toBeNull()
    expect(parseGitOrigin('')).toBeNull()
  })
  it('解析自托管 gitlab（host 含 gitlab）', () => {
    expect(parseGitOrigin('https://gitlab.example.com/team/sub/repo.git'))
      .toEqual({owner: 'sub', name: 'repo', source: 'gitlab'})
  })
})

describe('parseCloneUrl', () => {
  it('解析 https clone url 并返回 origin（带 .git）', () => {
    const r = parseCloneUrl('https://github.com/greensock/gsap-skills')
    expect(r).toEqual({owner: 'greensock', name: 'gsap-skills', source: 'github', origin: 'https://github.com/greensock/gsap-skills'})
  })
  it('SSH clone url → github', () => {
    const r = parseCloneUrl('git@github.com:greensock/gsap-skills.git')
    expect(r?.owner).toBe('greensock'); expect(r?.name).toBe('gsap-skills'); expect(r?.origin).toBe('git@github.com:greensock/gsap-skills.git')
  })
  it('非法 → null', () => {
    expect(parseCloneUrl('junk')).toBeNull()
  })
  it('owner/repo 简写 → github https', () => {
    expect(parseCloneUrl('greensock/gsap-skills'))
      .toEqual({owner: 'greensock', name: 'gsap-skills', source: 'github', origin: 'https://github.com/greensock/gsap-skills'})
  })
})

describe('repoDirName', () => {
  it('拼接 @source 后缀', () => {
    expect(repoDirName('gsap-skills')).toBe('gsap-skills@source')
  })
})
