import {useState} from 'react'

export function ImageViewer({src}: {src: string}) {
  const [mode, setMode] = useState<'fit' | 'zoom' | 'original'>('fit')
  return (
    <div style={{height: '100%', display: 'flex', flexDirection: 'column'}}>
      <div style={{display: 'flex', gap: 8, padding: 4}}>
        {(['fit', 'zoom', 'original'] as const).map(m => (
          <button key={m} onClick={() => setMode(m)} disabled={mode === m}>{m}</button>
        ))}
      </div>
      <div style={{flex: 1, overflow: 'auto', display: 'flex', alignItems: 'center', justifyContent: 'center'}}>
        <img src={src} alt={src} style={mode === 'original' ? {} : {maxWidth: '100%', maxHeight: '100%'}} />
      </div>
    </div>
  )
}
