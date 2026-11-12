import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
const require = createRequire(import.meta.url)
const api = (() => { try { return require('../notification-broker') } catch(e) { if(e.code==='MODULE_NOT_FOUND') return {}; throw e } })()
class Toast extends EventEmitter { static all=[]; static isSupported(){return true}; constructor(opts){super();this.opts=opts;Toast.all.push(this)} show(){this.shown=true} close(){this.closed=true} }
const favorite = serviceId => ({pinId:'pin-'+serviceId, serviceId,accountId:'a',chatId:'c',url:'https://example.test/chat'})
function setup(serviceId='mm', extra={}) { Toast.all=[]; const b=api.createNotificationBroker({Notification:Toast, icon:'logo.png', ledger:{claim:()=>true}, route:r=>b.routes.push(r), now:()=>2000,...extra}); b.routes=[]; b.setFavorites([favorite(serviceId)]); const stream=b.openStream({serviceId,accountId:'a',selfId:'self',liveAfter:1000}); return {b,stream} }
const incoming = (overrides={}) => ({eventId:'e1',chatId:'c',authorId:'other',occurredAt:1500,kind:'message',phase:'live',outgoing:false,replayed:false,body:'message',...overrides})
test('all four services: only exact favorite, branded toast, click routes trusted pin',()=>{ assert.equal(typeof api.createNotificationBroker,'function'); for(const service of ['mm','tg','max','ydx']) { const {b,stream}=setup(service); assert.equal(stream.accept(incoming({chatId:'not-favorite'})).status,'not-favorite'); assert.equal(stream.accept(incoming()).status,'shown'); const n=Toast.all[0]; assert.equal(n.opts.title,'Chat Hub'); assert.equal(n.opts.icon,'logo.png'); n.emit('click'); assert.deepEqual(b.routes,[favorite(service)]); } })
test('rejects own, replay, bootstrap, missing identity and non-message observations for every service',()=>{ for(const service of ['mm','tg','max','ydx']) {const {stream}=setup(service); for(const change of [{authorId:'self'},{outgoing:true},{replayed:true},{phase:'bootstrap'},{occurredAt:999},{occurredAt:1000},{occurredAt:3000},{eventId:''},{authorId:''},{outgoing:undefined},{replayed:undefined},{kind:'unread-delta'},{chatId:''}]) { assert.notEqual(stream.accept(incoming(change)).status,'shown',JSON.stringify(change)) } assert.equal(Toast.all.length,0) } })
test('retired stream cannot deliver after account/reconnect change',()=>{ const {b,stream}=setup(); b.openStream({serviceId:'mm',accountId:'a',selfId:'self',liveAfter:1400}); assert.equal(stream.accept(incoming()).status,'stale-stream') })
test('favorite removal closes existing toast and revokes clicks even after re-add',()=>{ const {b,stream}=setup(); stream.accept(incoming()); const n=Toast.all[0]; b.setFavorites([]); assert.equal(n.closed,true); b.setFavorites([favorite('mm')]); n.emit('click'); assert.equal(b.routes.length,0) })
test('URL rebind invalidates click; unchanged favorite survives refresh',()=>{ const {b,stream}=setup(); stream.accept(incoming()); b.setFavorites([favorite('mm')]); Toast.all[0].emit('click'); assert.equal(b.routes.length,1); b.setFavorites([{...favorite('mm'),url:'https://example.test/other'}]); Toast.all[0].emit('click'); assert.equal(b.routes.length,1) })
test('ledger claims stable scoped event before show and storage failure fails closed',()=>{ const calls=[]; const seen=new Set(); const {stream}=setup('mm',{ledger:{claim:k=>{calls.push(k);if(seen.has(k)) return false;seen.add(k);return true}}}); assert.equal(stream.accept(incoming()).status,'shown'); assert.equal(stream.accept(incoming()).status,'duplicate'); assert.equal(Toast.all.length,1); assert.equal(calls[0],JSON.stringify(['mm','a','c','e1'])); const bad=setup('mm',{ledger:{claim:()=>{throw Error('disk')}}}); assert.equal(bad.stream.accept(incoming()).status,'storage-error'); assert.equal(Toast.all.length,0) })
test('rebind revokes an unclicked toast and account switch closes pending toasts',()=>{
 const {b,stream}=setup(); stream.accept(incoming()); const first=Toast.all[0]
 b.setFavorites([{...favorite('mm'),url:'https://example.test/rebound'}])
 assert.equal(first.closed,true); first.emit('click'); assert.equal(b.routes.length,0)
 stream.accept(incoming({eventId:'e2'})); const second=Toast.all[1]
 b.openStream({serviceId:'mm',accountId:'other-account',selfId:'other-self',liveAfter:1000})
 assert.equal(second.closed,true); second.emit('click'); assert.equal(b.routes.length,0)
})
test('import/construction/favorite changes alone produce no notification',()=>{
 Toast.all=[]
 const b=api.createNotificationBroker({Notification:Toast,icon:'logo.png',ledger:{claim(){throw Error('no real event')}},route(){throw Error('no click')}})
 b.setFavorites([favorite('mm')]); b.dispose(); assert.equal(Toast.all.length,0)
})
test('claim precedes show and failed display cannot retry claimed event',()=>{
 const seen=new Set(), order=[]
 class FailToast extends Toast { show(){order.push('show');throw Error('display')} }
 const {stream}=setup('mm',{Notification:FailToast,ledger:{claim(k){order.push('claim');if(seen.has(k))return false;seen.add(k);return true}}})
 assert.equal(stream.accept(incoming()).status,'display-error')
 assert.deepEqual(order,['claim','show']);assert.equal(Toast.all[0].closed,true)
 assert.equal(stream.accept(incoming()).status,'duplicate')
})
export { setup, incoming, Toast }
