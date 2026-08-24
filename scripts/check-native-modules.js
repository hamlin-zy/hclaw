// scripts/check-native-modules.js — spec §7.1 U2：electron 运行时原生模块验证（临时脚本）
const {app} = require('electron')

app.whenReady().then(async () => {
    const results = {}
    try {
        const {DatabaseSync: Database} = require('@photostructure/sqlite')
        const db = new Database(':memory:')
        db.exec('CREATE TABLE t(x TEXT)')
        db.prepare('INSERT INTO t VALUES (?)').run('hello')
        const row = db.prepare('SELECT x FROM t').get()
        results.sqlite = row.x === 'hello' ? 'OK' : 'FAIL'
        db.close()
    } catch (e) {
        results.sqlite = 'FAIL: ' + e.message
    }
    try {
        const sharp = require('sharp')
        const meta = await sharp({create: {width: 8, height: 8, channels: 3, background: '#f00'}})
            .png().toBuffer()
            .then(buf => sharp(buf).metadata())
        results.sharp = meta.width === 8 && meta.height === 8 ? 'OK' : 'FAIL'
    } catch (e) {
        results.sharp = 'FAIL: ' + e.message
    }
    console.log(JSON.stringify(results))
    app.exit(Object.values(results).every(v => v === 'OK') ? 0 : 1)
})
