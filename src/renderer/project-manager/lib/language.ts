import type {Extension} from '@codemirror/state'
import {javascript} from '@codemirror/lang-javascript'
import {json} from '@codemirror/lang-json'
import {css} from '@codemirror/lang-css'
import {html} from '@codemirror/lang-html'

export async function getLanguageExtension(path: string): Promise<Extension[]> {
  const ext = path.split('.').pop()?.toLowerCase()
  switch (ext) {
    case 'ts': case 'tsx': case 'js': case 'jsx': case 'mjs': case 'cjs':
      return [javascript({jsx: ext === 'tsx' || ext === 'jsx'})]
    case 'json': return [json()]
    case 'css': case 'scss': return [css()]
    case 'html': case 'htm': return [html()]
    default: return []
  }
}
