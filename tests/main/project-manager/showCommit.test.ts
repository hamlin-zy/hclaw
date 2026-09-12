import {describe, it, expect} from 'vitest'
import {parseShowCommit} from '../../../src/main/project-manager/git/showCommit'

describe('parseShowCommit', () => {
  it('解析 name-status 输出', () => {
    const raw = 'abc123\nsubject\n\nM\tsrc/a.ts\nA\tsrc/new.ts\nR100\told.ts\tnew.ts\n'
    const result = parseShowCommit(raw, 'abc123', 'subject')
    expect(result.files).toEqual([
      {path: 'src/a.ts', status: 'M', additions: 0, deletions: 0},
      {path: 'src/new.ts', status: 'A', additions: 0, deletions: 0},
      {path: 'new.ts', status: 'R', oldPath: 'old.ts', additions: 0, deletions: 0},
    ])
  })
})
