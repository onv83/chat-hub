import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
const require=createRequire(import.meta.url)
const api=(()=>{try{return require('../notification-ledger')}catch(e){if(e.code==='MODULE_NOT_FOUND')return {};throw e}})()
const scratch=path.join(process.env.LOCALAPPDATA || path.dirname(fileURLToPath(import.meta.url)), 'hermes/cache/scratch')
fs.mkdirSync(scratch,{recursive:true})
const root=fs.mkdtempSync(path.join(scratch,'notification-ledger-'))
after(()=>fs.rmSync(root,{recursive:true,force:true}))
test('durable stable claims survive reopen; file stores no message bodies',()=>{assert.equal(typeof api.createFileLedger,'function'); fs.mkdirSync(root,{recursive:true}); const file=path.join(root,'seen.json'); fs.rmSync(file,{force:true}); const a=api.createFileLedger(file); assert.equal(a.claim('["mm","a","c","m1"]'),true); assert.equal(a.claim('["mm","a","c","m1"]'),false); const b=api.createFileLedger(file); assert.equal(b.claim('["mm","a","c","m1"]'),false); assert.equal(b.claim('["tg","a","c","m1"]'),true); assert.ok(!fs.readFileSync(file,'utf8').includes('"mm"')); fs.rmSync(root,{recursive:true,force:true}) })
test('corrupt ledger fails closed, never silently clears dedupe',()=>{ assert.equal(typeof api.createFileLedger,'function'); fs.mkdirSync(root,{recursive:true}); const file=path.join(root,'bad.json'); fs.writeFileSync(file,'{bad'); assert.throws(()=>api.createFileLedger(file),/ledger unavailable/i); fs.writeFileSync(file,'{"version":1,"seen":["bad"]}'); assert.throws(()=>api.createFileLedger(file),/ledger unavailable/i); fs.rmSync(root,{recursive:true,force:true}) })
test('failed atomic replacement preserves old ledger, no acknowledgement',()=>{fs.mkdirSync(root,{recursive:true}); const file=path.join(root,'seen.json'); fs.rmSync(file,{force:true}); const a=api.createFileLedger(file); a.claim('one'); const before=fs.readFileSync(file,'utf8'); const bad=api.createFileLedger(file,{fs:{...fs,renameSync(){throw Error('fault')}}}); assert.throws(()=>bad.claim('two')); assert.equal(fs.readFileSync(file,'utf8'),before); assert.deepEqual(fs.readdirSync(root),['seen.json']); fs.rmSync(root,{recursive:true,force:true}) })
