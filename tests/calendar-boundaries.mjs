import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
const src=readFileSync(new URL('../renderer.js',import.meta.url),'utf8')
const start=src.indexOf('function parseChatTime(')
const code=src.slice(start,src.indexOf('\n}',start)+2)
function parse(text, now) {
  class FrozenDate extends Date { constructor(...args){super(...(args.length?args:[now]))} static now(){return now} }
  const ctx=vm.createContext({Date:FrozenDate}); vm.runInContext(code,ctx)
  return ctx.parseChatTime(text)
}
function rowTime(ms, now, dayOnly=false) {
  const start=src.indexOf('function fmtRowTime(')
  const code=src.slice(start,src.indexOf('\n}',start)+2)
  class FrozenDate extends Date { constructor(...args){super(...(args.length?args:[now]))} static now(){return now} }
  const ctx=vm.createContext({Date:FrozenDate}); vm.runInContext(code,ctx)
  return ctx.fmtRowTime(ms,dayOnly)
}
const at=(y,m,d,h=12,min=0)=>new Date(y,m-1,d,h,min).getTime()
for(const [text,now,expected] of [
  ['31.12',at(2026,1,1,8),at(2025,12,31)],
  ['01.01',at(2026,1,1,8),at(2026,1,1)],
  ['Jan 1',at(2026,1,1,8),at(2026,1,1)],
  ['1 янв',at(2026,1,1,8),at(2026,1,1)],
  ['Dec 31',at(2026,1,1,8),at(2025,12,31)],
  ['29.02',at(2025,3,1,8),at(2024,2,29)],
  ['Feb 29',at(2024,2,29,8),at(2024,2,29)],
  ['29 фев',at(2024,2,28,8),at(2020,2,29)],
  ['28.02',at(2024,2,29,8),at(2024,2,28)],
  ['31.12.25',at(2026,1,1),at(2025,12,31)],
  ['02/29/2024',at(2026,1,1),at(2024,2,29)],
  ['29.02',at(2104,2,28,8),at(2096,2,29)],
  ['Jan 1',at(2026,1,1,18),at(2026,1,1)],
  ['Feb 29',at(2000,2,29,8),at(2000,2,29)],
  ['вчера',at(2026,1,1,8),at(2025,12,31)],
]) test('calendar boundary '+text+' at '+new Date(now).toISOString(),()=>{
  const result=parse(text,now); assert.equal(result.at,expected); assert.equal(result.dayOnly,true)
})
for(const text of ['24:00','12:60','99:99','31.04','Apr 31','0 янв','00.01','12.00','12.13','29.02.2025','02/29/2025','02/30/2024','31.12.123']) test('reject invalid '+text,()=>{
  assert.equal(parse(text,at(2026,1,1,8)).at,0)
})
test('valid clock retains minute precision',()=>{
  const result=parse('07:05',at(2026,1,1,8)); assert.equal(result.at,at(2026,1,1,7,5)); assert.equal(result.dayOnly,false)
})
test('clock later than now rolls to the previous day, never into the future',()=>{
  const result=parse('18:06',at(2026,11,16,16,42));
  assert.equal(result.at,at(2026,11,15,18,6));
  assert.equal(result.dayOnly,false)
})
test('row time shows clock plus yesterday or calendar date for exact older messages',()=>{
  const now=at(2026,11,16,17,22)
  assert.equal(rowTime(at(2026,11,16,16,24),now), '16:24')
  assert.equal(rowTime(at(2026,11,15,15,3),now), '15:03 вчера')
  assert.equal(rowTime(at(2026,11,14,18,6),now), '18:06 14.11')
  assert.equal(rowTime(at(2025,12,31,7,5),now), '07:05 31.12.25')
  assert.equal(rowTime(at(2026,11,14,12),now,true), '14.11')
})
