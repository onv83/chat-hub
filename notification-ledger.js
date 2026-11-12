'use strict'
const nodeFs = require('fs')
const path = require('path')
const { createHash, randomUUID } = require('crypto')

// Single main-process writer, separate from config.json. No TTL: replay safety
// wins over silent eviction. Replace with a transactional store before high volume.
function createFileLedger(file, { fs = nodeFs } = {}) {
  let seen = new Set()
  try {
    const saved = JSON.parse(fs.readFileSync(file,'utf8'))
    if (saved.version !== 1 || !Array.isArray(saved.seen) || saved.seen.some(k => typeof k !== 'string' || !/^[a-f0-9]{64}$/.test(k))) throw Error('Invalid ledger')
    seen = new Set(saved.seen)
  } catch(e) { if (e.code !== 'ENOENT') throw new Error('Notification ledger unavailable') }
  return { claim(key) {
    if (typeof key !== 'string' || !key) throw TypeError('Invalid ledger key')
    const digest = createHash('sha256').update(key).digest('hex')
    if(seen.has(digest)) return false
    const next = new Set(seen); next.add(digest)
    fs.mkdirSync(path.dirname(file),{recursive:true})
    const temp = file + '.tmp-' + randomUUID()
    let fd, owned = false
    try {
      fd = fs.openSync(temp,'wx',0o600); owned = true
      fs.writeFileSync(fd, JSON.stringify({version:1,seen:[...next]}),'utf8')
      fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined
      fs.renameSync(temp,file)
      seen = next
      return true
    } finally {
      if(fd !== undefined) try { fs.closeSync(fd) } catch {}
      if(owned) try { fs.unlinkSync(temp) } catch {}
    }
  } }
}
module.exports = { createFileLedger }
