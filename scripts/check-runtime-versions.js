// scripts/check-runtime-versions.js — 升级后运行时版本断言（spec §7.1 U3）
const {app} = require('electron')

const EXPECT = [
    ['electron', '43.'],
    ['chrome', '150.'],
    ['node', '24.18.'],
]

app.whenReady().then(() => {
    const v = process.versions
    console.log(JSON.stringify({electron: v.electron, chrome: v.chrome, node: v.node, v8: v.v8}))
    const bad = EXPECT.filter(([k, prefix]) => !String(v[k]).startsWith(prefix))
    if (bad.length) {
        console.error('VERSION MISMATCH: ' + bad.map(([k]) => `${k}=${v[k]}`).join(', '))
        app.exit(1)
        return
    }
    console.log('OK')
    app.exit(0)
})
