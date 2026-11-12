import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const src=readFileSync(new URL('../renderer.js',import.meta.url),'utf8');
function fn(n){const a=src.search(new RegExp('(?:async )?function '+n+'\\('));if(a<0)return '';const b=src.slice(a+1).search(/\n(?:async )?function /);return src.slice(a,b<0?undefined:a+1+b)}
const at=(day,h=12,m=0)=>new Date(2026,10,day,h,m).getTime();
const now=at(12,9);
function harness(service){
 class Clock extends Date{constructor(...args){super(...(args.length?args:[now]))}static now(){return now}}
 const pins=['older','newer'].map(id=>({id,serviceId:service,url:'https://fixture.invalid/'+id}));
 const state={cfg:{services:[{id:service}],pinned:pins},svcViews:{},pinViews:{}};
 for(const k of ['pinAvatars','unreadTotals','unreadTotalsAt','unreadBaseC','unreadBaseM','prevUnread','rankAct','lastMsgAt','lastMsgText','lastMsgPreview','liveAct','tgPeerOf'])state[k]={};
 state.lastMsgAt={older:at(11,15),newer:at(11,22,21)};
 state.lastMsgText={older:'11.11 15:00',newer:'11.11 22:21'};
 let observations=pins.map(p=>({id:p.id,found:true,time:'вчера',count:0,mentions:0}));
 state.svcViews[service]={isConnected:true,addEventListener(){},executeJavaScript:async source=>{new vm.Script(source);return JSON.stringify({favs:observations,svcTotals:{total:0,mentions:0}})}};
 const ctx=vm.createContext({state,Date:Clock,console,setTimeout,clearTimeout,document:{querySelector(){return null}},favoritesOf:()=>state.cfg.pinned,svcViewFor:()=>state.svcViews[service],updateBadge(){},updateBadge2(){},renderChatList(){},scheduleActSave(){},mmTabCounts:async()=>{},mmLastPosts:async()=>{},tgSearchResolve:async()=>null,__chatHubGrabAvatar:function(){},formatMaxPreview:function(){},UNREAD_EXTRACTORS:{[service]:function(){}}});
 for(const n of ['__chatHubScanRows','__chatHubBoundedAvatar','runUnreadJob','unreadViewState','unreadGuestCall','pollUnread','pollUnreadService','refreshUnreadPresentation','unreadDeltaFor','shouldBumpLiveAct','parseChatTime','fmtChatWhen','sortFavoritesByActivity','mergeLastMessageTime','activitySnapshot','ensureKeys','restorePreviewAuthor'])vm.runInContext(fn(n),ctx);
 return {ctx,state,set(rows){observations=rows}};
}
for(const service of ['mm','tg','max','ydx'])test(service+': midnight order and verified provenance survive restart and missing/day-only refresh',async()=>{
 const h=harness(service);h.ctx.tgScrollDone=false;
 h.ctx.mergeLastMessageTime('older',{at:at(11,23,59),dayOnly:false,source:'fixture-metadata',serviceId:service,canonicalUrl:h.state.cfg.pinned[0].url,accountId:'1',peerId:'22',messageId:'42'});
 h.ctx.mergeLastMessageTime('newer',{at:at(12,0,1),dayOnly:false,source:'fixture-metadata',serviceId:service,canonicalUrl:h.state.cfg.pinned[1].url,accountId:'1',peerId:'33',messageId:'43'});
 const saved=JSON.parse(JSON.stringify(h.ctx.activitySnapshot()));
 const r=harness(service);Object.assign(r.state.cfg,{activity:saved,actReset1:true,actReset2:true,actReset3:true,actReset4:true,actReset5:true});r.ctx.ensureKeys(r.state.cfg);
 r.set([{id:'older',found:true,time:'вчера',count:0},{id:'newer',found:false,time:'вчера',count:0}]);await r.ctx.pollUnread();
 assert.equal(r.state.lastMsgAt.older,at(11,23,59));assert.equal(r.state.lastMsgAt.newer,at(12,0,1));
 assert.equal(r.state.lastMsgSource.older.messageId,'42');assert.equal(r.state.lastMsgSource.newer.messageId,'43');
 assert.deepEqual(r.state.cfg.pinned.map(p=>p.id),['newer','older']);
});
for(const service of ['mm','tg','max','ydx'])test(service+': precise new clock advances activity; absent/invalid observations do not',async()=>{
 const h=harness(service);h.set([{id:'newer',found:true,time:'08:45',count:1}]);await h.ctx.pollUnread();
 assert.equal(h.state.lastMsgAt.newer,at(12,8,45));assert.equal(h.state.lastMsgDayOnly.newer,false);
 h.set([{id:'newer',found:false,time:'09:00',count:0}]);await h.ctx.pollUnread();
 assert.equal(h.state.lastMsgAt.newer,at(12,8,45));
 h.set([{id:'newer',found:true,time:'invalid',count:0}]);await h.ctx.pollUnread();
 assert.equal(h.state.lastMsgAt.newer,at(12,8,45));
 h.state.cfg.pinned.find(p=>p.id==='older').priority=true;h.ctx.sortFavoritesByActivity();
 assert.equal(h.state.cfg.pinned[0].id,'older','explicit priority still takes precedence');
});
for(const service of ['mm','tg','max','ydx'])test(service+': precision survives activity round-trip; sort ignores stale click/detection liveAct',()=>{
 const h=harness(service);h.ctx.mergeLastMessageTime('newer',{at:at(12),dayOnly:true});
 h.ctx.tgScrollDone=false;
 const saved=h.ctx.activitySnapshot();assert.equal(saved.lastMsgDayOnly?.newer,true);
 const restored=harness(service);Object.assign(restored.state.cfg,{activity:saved,actReset1:true,actReset2:true,actReset3:true,actReset4:true,actReset5:true});
 restored.ctx.ensureKeys(restored.state.cfg);assert.equal(restored.state.lastMsgDayOnly?.newer,true);
 restored.state.liveAct.older=at(13,23);restored.ctx.sortFavoritesByActivity();
 assert.equal(restored.state.cfg.pinned[0].id,'newer');
});
for(const service of ['mm','tg','max','ydx'])test(service+': changed calendar day stays imprecise and accepts earlier-than-noon exact metadata',async()=>{
 const h=harness(service);h.state.lastMsgAt.newer=at(10,22);
 h.set([{id:'newer',found:true,time:'вчера',count:0}]);await h.ctx.pollUnread();
 assert.equal(h.state.lastMsgAt.newer,at(11));
 assert.equal(h.state.lastMsgDayOnly?.newer,true);
 h.ctx.mergeLastMessageTime('newer',{at:at(11,8),dayOnly:false});
 assert.equal(h.state.lastMsgAt.newer,at(11,8));assert.equal(h.state.lastMsgDayOnly.newer,false);
 h.ctx.mergeLastMessageTime('newer',{at:at(11,19),dayOnly:false});
 assert.equal(h.state.lastMsgAt.newer,at(11,19));
 h.ctx.mergeLastMessageTime('newer',{at:at(10,23),dayOnly:false});
 assert.equal(h.state.lastMsgAt.newer,at(11,19),'stale prior day cannot regress activity');
});
for(const service of ['mm','tg','max','ydx'])test(service+': date-only yesterday cannot erase known precise ordering',async()=>{
 const h=harness(service);await h.ctx.pollUnread();
 assert.equal(h.state.lastMsgAt.newer,at(11,22,21));
 assert.equal(h.state.lastMsgAt.older,at(11,15));
 assert.deepEqual(h.state.cfg.pinned.map(p=>p.id),['newer','older']);
});
