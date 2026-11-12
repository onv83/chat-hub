import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
const src = readFileSync(new URL('../renderer.js', import.meta.url), 'utf8')
function fn(name) {
  const start = src.search(new RegExp('^(?:async )?function ' + name + '\\(', 'm'))
  assert.notEqual(start, -1, name)
  const end = src.indexOf('\n}', start) + 2
  return src.slice(start, end)
}
function restored(preview, auth) {
  const cfg = {pinned:[{id:'p',title:'Contact',url:'https://example/#@contact'}], activity:{lastMsgPreview:{p:preview},msgAuth:{p:auth}},actReset1:true,actReset2:true,actReset3:true,actReset4:true,actReset5:true}
  const state = {cfg}
  for (const k of ['lastMsgAt','lastMsgText','lastMsgPreview','msgAuth','liveAct','tgPeerOf','prevUnread','unreadBaseC','unreadBaseM']) state[k]={}
  const ctx=vm.createContext({state,console:{log(){}},tgScrollDone:false})
  for(const name of ['tgPreviewAuthored','ensureKeys']) vm.runInContext(fn(name),ctx)
  // Load optional helpers so the same test runs against the original source.
  if(src.includes('function restorePreviewAuthor(')) vm.runInContext(fn('restorePreviewAuthor'),ctx)
  ctx.ensureKeys(cfg)
  return ctx
}
test('restoration never replaces a newer preview with cached author text',()=>{
  const c=restored('new message',{text:'old message',out:true})
  assert.equal(c.state.lastMsgPreview.p,'new message')
})
test('ensureKeys only hydrates activity once, preserving live observations',()=>{
  const c=restored('old message',null)
  c.state.lastMsgPreview.p='live message'; c.state.lastMsgAt.p=200
  c.state.cfg.activity.lastMsgAt={p:100}
  c.ensureKeys(c.state.cfg)
  assert.equal(c.state.lastMsgPreview.p,'live message')
  assert.equal(c.state.lastMsgAt.p,200)
})
function polling(preview, author, messageId) {
  const state={cfg:{services:[{id:'max'}],pinned:[{id:'p',serviceId:'max',title:'Contact',url:'https://fixture.invalid/-1'}]},svcViews:{},pinViews:{},msgAuth:{p:author}}
  for(const k of ['pinAvatars','unreadTotals','unreadTotalsAt','unreadBaseC','unreadBaseM','prevUnread','rankAct','lastMsgAt','lastMsgText','lastMsgPreview','liveAct','tgPeerOf']) state[k]={}
  state.svcViews.max={isConnected:true,addEventListener(){},executeJavaScript:async()=>JSON.stringify({favs:[{id:'p',found:true,preview,messageId}],svcTotals:{total:0,mentions:0}})}
  const ctx=vm.createContext({state,Date,console,setTimeout,clearTimeout,document:{querySelector(){return null}},favoritesOf:()=>state.cfg.pinned,svcViewFor:()=>state.svcViews.max,updateBadge(){},updateBadge2(){},sortFavoritesByActivity(){},scheduleActSave(){},__chatHubGrabAvatar:function(){},formatMaxPreview:function(){},UNREAD_EXTRACTORS:{max:function(){}}})
  for(const n of ['__chatHubScanRows','__chatHubBoundedAvatar','runUnreadJob','unreadViewState','unreadGuestCall','pollUnread','pollUnreadService','refreshUnreadPresentation','unreadDeltaFor','shouldBumpLiveAct']) vm.runInContext(fn(n),ctx)
  if(src.includes('function restorePreviewAuthor(')) vm.runInContext(fn('restorePreviewAuthor'),ctx)
  return {ctx,state}
}
for(const [preview,author,id,expected] of [
  ['long message',{text:'message',out:true},undefined,'long message'],
  ['Contact: message',{text:'message',out:true},undefined,'Contact: message'],
  ['message',{text:'message',out:true,messageId:'old'},'new','message'],
  ['message',{text:'message',out:true,messageId:'same'},'same','Вы: message'],
  ['message',{text:'message',out:true,messageId:'known'},undefined,'message'],
  ['message',{text:'message',out:true},'known','message'],
  ['message',{text:'message',out:false,name:'Sender'},undefined,'Sender: message'],
  ['https://fixture.invalid',{text:'fixture',out:true},undefined,'https://fixture.invalid'],
  ['message',{text:'message',out:false,dm:true},undefined,'message'],
]) test('poll preview identity: '+JSON.stringify([preview,author,id]),async()=>{
  const h=polling(preview,author,id); await h.ctx.pollUnread()
  assert.equal(h.state.lastMsgPreview.p,expected)
})

test('stale open-chat bubble cannot replace a newer list preview',async()=>{
  const h=polling('new message',null)
  h.state.pinViews.p={isConnected:true,addEventListener(){}}
  h.ctx.grabViewLastMsgMax=async()=>({text:'old message',out:true})
  await h.ctx.pollUnread()
  assert.equal(h.state.lastMsgPreview.p,'new message')
})

test('TG search merge does not invent sender from chat title',async()=>{
  const h=polling('message',null)
  h.state.cfg.services[0].id='tg'; h.state.cfg.pinned[0].serviceId='tg'
  h.state.svcViews.tg=h.state.svcViews.max
  h.ctx.UNREAD_EXTRACTORS.tg=function(){}
  h.ctx.tgSearchResolve=async()=>({favs:[{id:'p',preview:'message',found:true}]})
  await h.ctx.pollUnread()
  assert.equal(h.state.lastMsgPreview.p,'message')
})

test('TG guest does not invent author from username chat title',async()=>{
  const row={cloneNode(){return {...this}},getAttribute:n=>({'data-peer-id':'123',href:'#@contact'}[n]||''),querySelector:s=>s==='.peer-title'?{textContent:'Contact'}:s==='.dialog-subtitle'?{textContent:'message'}:null}
  const c=vm.createContext({window:{},document:{querySelector:()=>null,querySelectorAll:()=>[row]}})
  for (const n of ['__chatHubTgUnread','__chatHubScanRows','__chatHubBoundedAvatar']) vm.runInContext(fn(n),c)
  const result=JSON.parse(await c.__chatHubTgUnread([{id:'p',url:'https://example/#123'}],false))
  assert.equal(result.favs[0].preview,'message')
})
test('disabled author sweep also cannot regress newer previews',async()=>{
  const h=polling('new message',null)
  h.state.cfg.pinned[0].url='https://web.max.ru/-1'
  h.state.lastMsgPreview.p='new message'; h.state.pinViews.p={}
  h.ctx.grabViewLastMsgMax=async()=>({text:'old message',out:true})
  vm.runInContext(fn('learnAuthorSweep'),h.ctx)
  await h.ctx.learnAuthorSweep()
  assert.equal(h.state.lastMsgPreview.p,'new message')
})

test('row rendering preserves unknown and explicit authors',()=>{
  const c=restored('message',null)
  c.escapeHtml=s=>s
  vm.runInContext(fn('setRowPreview'),c)
  for(const text of ['message','Contact: message']) {
    const el={dataset:{},closest:()=>({dataset:{pin:'p'}}),querySelector(){return {textContent:''}}}
    c.setRowPreview(el,text)
    assert.equal(el.dataset.txt,text)
  }
})
for (const service of ['tg','max']) test(service+' fallback receives canonical pin URL, never extractor URL',async()=>{
  const h=polling('new message',null), calls=[]
  const pin=h.state.cfg.pinned[0]; pin.serviceId=service
  pin.url=service==='tg'?'https://web.telegram.org/k/#123':'https://web.max.ru/-123'
  h.state.cfg.services[0].id=service; h.state.svcViews[service]=h.state.svcViews.max
  h.ctx.UNREAD_EXTRACTORS[service]=function(){}
  h.ctx.tgSearchResolve=async()=>null
  h.state.pinViews.p={isConnected:true,addEventListener(){}}
  h.ctx.grabAvatarFromPinView=async(view,url)=>{calls.push(['avatar',url]);return 'avatar'}
  h.ctx.grabViewLastMsg=h.ctx.grabViewLastMsgMax=async(view,url)=>{calls.push(['preview',url]);return {text:'old message',out:true}}
  await h.ctx.pollUnread()
  assert.equal(calls.length,service==='tg'?2:1)
  for(const [,url] of calls) assert.equal(url,pin.url)
  assert.equal(h.state.lastMsgPreview.p,'new message')
})

function pinGuest(service, liveUrl, owner='123', headerAvatar=true) {
  const text={textContent:'old message',cloneNode(){return {...this,querySelectorAll:()=>[]}}}
  const bubble={classList:{contains:()=>true},querySelector:s=>s==='.message, .translatable-message'||s==='[data-message-markup], .bubbleContent .text'?text:s==='[data-bubbles-variant]'?{getAttribute:()=> 'outgoing'}:null}
  const header={getAttribute:()=>owner}
  const avatar={src:'data:synthetic-avatar'}
  const doc={querySelector:s=>s.includes('data-peer-id')?header:s.includes('.avatar img')?(headerAvatar||s.includes(', .avatar img')?avatar:null):null,
    querySelectorAll:s=>s==='.bubbles .bubble'||s==='.message'?[bubble]:[]}
  const guest=vm.createContext({document:doc,location:new URL(liveUrl),URL})
  const scripts=[]
  const wv={async executeJavaScript(source){scripts.push(source);return await new vm.Script(source).runInContext(guest)}}
  const ctx=vm.createContext({URL})
  for(const n of ['grabAvatarFromPinView','grabViewLastMsg','grabViewLastMsgMax']) vm.runInContext(fn(n),ctx)
  if(src.includes('function __chatHubTgViewOwns(')) vm.runInContext(fn('__chatHubTgViewOwns'),ctx)
  return {ctx,wv,scripts,guest}
}
for(const helper of ['grabAvatarFromPinView','grabViewLastMsg']) {
  test(helper+' rejects same URL with stale header owner',async()=>{
    const h=pinGuest('tg','https://web.telegram.org/k/#123','999')
    assert.ok(!await h.ctx[helper](h.wv,'https://web.telegram.org/k/#123'))
    assert.equal(h.scripts.length,1)
  })
  test(helper+' accepts verified numeric header owner',async()=>{
    const h=pinGuest('tg','https://web.telegram.org/k/#123')
    assert.ok(await h.ctx[helper](h.wv,'https://web.telegram.org/k/#123'))
    assert.equal(h.scripts.length,1)
  })
  test(helper+' refuses foreign origin despite same hash',async()=>{
    const h=pinGuest('tg','https://other.invalid/k/#123')
    assert.ok(!await h.ctx[helper](h.wv,'https://web.telegram.org/k/#123'))
  })
}
test('TG header avatar fallback never reads an arbitrary sidebar avatar',async()=>{
  const h=pinGuest('tg','https://web.telegram.org/k/#123','123',false)
  assert.ok(!await h.ctx.grabAvatarFromPinView(h.wv,'https://web.telegram.org/k/#123'))
})
for(const [live,want,found] of [
  ['https://web.max.ru/-123','https://web.max.ru/-123',true],
  ['https://web.max.ru/1234','https://web.max.ru/123',false],
  ['https://other.invalid/123','https://web.max.ru/123',false],
]) test('MAX generated fallback exact URL '+live+' -> '+want,async()=>{
  const h=pinGuest('max',live)
  assert.equal(!!await h.ctx.grabViewLastMsgMax(h.wv,want),found)
  assert.equal(h.scripts.length,1)
})

async function tgRows(pin, rows) {
  const nodes = rows.map(({pid,href,title})=>({cloneNode(){return this},getAttribute:n=>n==='data-peer-id'?pid:n==='href'?href:'',querySelector:s=>s==='.peer-title'?{textContent:title}:s==='.dialog-subtitle'?{textContent:'foreign preview'}:null}))
  const c=vm.createContext({window:{},document:{querySelector:()=>null,querySelectorAll:()=>nodes}})
  for(const n of ['__chatHubTgUnread','__chatHubScanRows','__chatHubBoundedAvatar']) vm.runInContext(fn(n),c)
  return JSON.parse(await c.__chatHubTgUnread([{id:'p',...pin}],false)).favs[0]
}
for(const pin of [
  {url:'https://example/#123',title:'Contact'},
  {url:'https://example/#123',pid:'999',title:'Contact'},
  {url:'https://example/#@contact',title:'Contact'},
  {url:'https://example/#@contact',pid:'999',title:'Contact'},
]) test('TG stable identity refuses title/cache conflict '+JSON.stringify(pin),async()=>{
  const r=await tgRows(pin,[{pid:'999',href:'#@other',title:'Contact'}])
  assert.equal(r.found,false); assert.equal(r.preview,''); assert.equal(r.pid,null)
})
test('TG username exact href precedes a same-title stranger',async()=>{
  const r=await tgRows({url:'https://example/#@contact',title:'Contact'},[
    {pid:'999',href:'#999',title:'Contact'},{pid:'123',href:'#@contact',title:'Renamed'}])
  assert.equal(r.pid,'123')
})
test('TG title fallback refuses multiple differently named candidates',async()=>{
  const r=await tgRows({url:'https://example/',title:'Contact'},[
    {pid:'1',href:'#1',title:'Contact team'},{pid:'2',href:'#2',title:'Contact extended team'}])
  assert.equal(r.found,false)
})
test('numeric pin cache admission rejects a different peer despite title match',()=>{
  const c=vm.createContext({}); vm.runInContext(fn('tgPidSafe'),c)
  assert.equal(c.tgPidSafe({url:'https://example/#123',title:'Contact'},'999','Contact'),false)
})

test('TG real generated poll preserves unread for mismatch, clears unverified preview, then accepts exact cache and zero',async()=>{
  const h=polling('',null), outputs=[]
  const pin=h.state.cfg.pinned[0]; pin.serviceId='tg'; pin.url='https://web.telegram.org/k/#123'
  h.state.cfg.services[0].id='tg'; h.state.pinAvatars.p='cached avatar'
  h.state.unreadTotals.p={c:7,m:0}; h.state.unreadTotalsAt.p=42
  h.state.lastMsgPreview.p='cached preview'; h.state.lastMsgAt.p=100
  let pid='999'
  const row={cloneNode(){return this},getAttribute:n=>n==='data-peer-id'?pid:n==='href'?'#'+pid:'',querySelector:s=>s==='.peer-title'?{textContent:'Contact'}:s==='.dialog-subtitle'?{textContent:'new preview'}:null}
  // Numeric service unread now requires the same verified account/peer dialog
  // metadata as aliases; a DOM row without a badge alone cannot prove zero.
  const guest=vm.createContext({window:{},setTimeout,clearTimeout,
    apiManagerProxy:{mirrors:{state:{userId:1,authState:{_:'authStateSignedIn'}},peers:{1:{_:'user',id:1},123:{_:'user',id:123}}}},
    rootScope:{myId:1,managers:{dialogsStorage:{getDialogOnly:async()=>({_:'dialog',peer:{_:'peerUser',user_id:Number(pid)},unread_count:0,unread_mentions_count:0,pFlags:{}})}}},
    document:{querySelector:()=>null,querySelectorAll:()=>[row]}})
  h.state.svcViews.tg={async executeJavaScript(code){const result=await new vm.Script(code).runInContext(guest);outputs.push(JSON.parse(result));return result}}
  h.ctx.svcViewFor=()=>h.state.svcViews.tg
  for(const n of ['__chatHubTgUnread','tgPidSafe','applyTgIdentityObservation']) vm.runInContext(fn(n),h.ctx)
  h.ctx.UNREAD_EXTRACTORS.tg=h.ctx.__chatHubTgUnread
  h.ctx.tgSearchResolve=async()=>null
  await h.ctx.pollUnread()
  assert.equal(outputs.length,1); assert.equal(outputs[0].favs[0].found,false)
  assert.equal(h.state.unreadTotals.p.c,7); assert.equal(h.state.unreadTotalsAt.p,42)
  assert.ok(!h.state.lastMsgPreview.p); assert.equal(h.state.lastMsgAt.p,100)
  pid='123'
  const message={_:'message',mid:42,peerId:123,date:1794410337,pFlags:{},fromId:99,message:'new preview'}
  guest.apiManagerProxy.mirrors.messages={'0_history':{42:message}}
  guest.apiManagerProxy.getHistoryMessagesStorage=id=>`${id}_history`
  guest.apiManagerProxy.getMessageFromStorage=()=>message
  guest.rootScope.managers.dialogsStorage.getDialogOnly=async()=>({_:'dialog',peer:{_:'peerUser',user_id:123},top_message:42,unread_count:0,unread_mentions_count:0,pFlags:{}})
  await h.ctx.pollUnread()
  assert.equal(outputs.length,2); assert.equal(outputs[1].favs[0].found,true)
  assert.equal(h.state.unreadTotals.p.c,0); assert.equal(h.state.lastMsgPreview.p,'new preview')
})
for(const [rows,expected] of [
  [[{pid:'123',href:'#@contact',title:'Renamed'}],true],
  [[{pid:'123',href:'#@contact',title:'Renamed'},{pid:'999',href:'#@contact',title:'Other'}],false],
]) test('TG username matches require a unique peer '+expected,async()=>{
  assert.equal((await tgRows({url:'https://example/#@contact',title:'Contact'},rows)).found,expected)
})
test('TG canonical numeric peer beats a poisoned cache even after title rename',async()=>{
  const r=await tgRows({url:'https://example/#123',pid:'999',title:'Contact'},[
    {pid:'999',href:'#999',title:'Contact'},{pid:'123',href:'#123',title:'Renamed'}])
  assert.equal(r.pid,'123')
})
for(const owner of ['123','999','']) test('TG username header needs matching direct row evidence: '+owner,async()=>{
  const h=pinGuest('tg','https://web.telegram.org/k/#@contact',owner)
  const previous=h.guest.document.querySelectorAll
  h.guest.document.querySelectorAll=s=>s==='a.row-clickable'?[{getAttribute:n=>n==='href'?'#@contact':'123'}]:previous(s)
  assert.equal(!!await h.ctx.grabViewLastMsg(h.wv,'https://web.telegram.org/k/#@contact'),owner==='123')
})

test('unknown author stays unknown in a username-addressed chat',()=>{
  assert.equal(restored('message',null).state.lastMsgPreview.p,'message')
})
