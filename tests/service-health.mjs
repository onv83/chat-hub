import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import health from '../service-health.js';
const blank = { root:true, ready:'complete', bodyChildren:0, scripts:0, login:false };
function fixture() {
  const children=[], timers=new Map(), listeners=new Map(); let id=0, calls=0, reloads=0;
  let response = async () => blank;
  const doc={createElement:()=>({ setAttribute(){}, remove(){}, hidden:false })};
  const bar={ownerDocument:doc,appendChild:n=>children.push(n)};
  const wv={isConnected:true,isLoading:()=>false,
    addEventListener:(n,cb)=>listeners.set(n,cb),removeEventListener:n=>listeners.delete(n),
    executeJavaScript:src=>{new vm.Script(src);calls++;return response()},reload:()=>reloads++};
  const api=health.attach(wv,bar,{setTimeout:(cb,ms)=>{timers.set(++id,{cb,ms});return id},clearTimeout:i=>timers.delete(i),confirm:()=>true});
  return {api,wv,children,timers,listeners,setResponse:fn=>response=fn,calls:()=>calls,reloads:()=>reloads};
}
test('startup/check are read only; explicit recovery rechecks and reloads at most once',async()=>{
  const f=fixture();
  await [...f.timers.values()].find(t=>t.ms===15000).cb();
  assert.equal(f.reloads(),0); assert.equal(f.children[1].hidden,false);
  await f.children[1].onclick(); await f.children[1].onclick();
  assert.equal(f.calls(),2); assert.equal(f.reloads(),1);
});
test('chat navigation between diagnosis and click prevents recovery',async()=>{
  const f=fixture(); await f.api.inspect();
  f.setResponse(async()=>({...blank,root:false,bodyChildren:8}));
  await f.children[1].onclick(); assert.equal(f.reloads(),0);
});
test('hung guest remains physically single-flight after timeout and 100 checks',async()=>{
  const f=fixture(); let finish;
  f.setResponse(()=>new Promise(r=>finish=r)); const pending=f.api.inspect();
  [...f.timers.values()].find(t=>t.ms===2500).cb();
  for(let i=0;i<100;i++) await f.api.inspect();
  assert.equal(f.calls(),1); assert.equal(f.reloads(),0);
  f.listeners.get('did-start-loading')(); finish(blank); await pending;
  assert.equal(f.children[1].hidden,true);
  f.api.dispose(); assert.equal(f.listeners.size,0); assert.equal(f.timers.size,0);
});
test('subframe load errors do not poison diagnosis; main frame errors and crashes disable recovery',async()=>{
  const f=fixture();
  f.listeners.get('did-fail-load')({isMainFrame:false,errorCode:-105}); await f.api.inspect();
  assert.equal(f.children[1].hidden,false);
  f.listeners.get('did-fail-load')({isMainFrame:true,errorCode:-105}); await f.api.inspect();
  assert.equal(f.children[1].hidden,true); assert.equal(f.api.records.at(-1).state,'load-error');
  f.listeners.get('render-process-gone')(); assert.equal(f.children[1].hidden,true);
});
test('serialized structural probe returns no text or URL and recognizes login',()=>{
  const context={location:{origin:'https://telemost.yandex.ru',pathname:'/',search:'',hash:'',href:'https://telemost.yandex.ru/'},document:{readyState:'complete',body:null,scripts:[],querySelector:()=>null}};
  const result=vm.runInNewContext('('+health.probe.toString()+')()',context);
  assert.equal(health.classify(result),'empty-root');
  context.document.body={childElementCount:0,childNodes:[{nodeType:3}]};
  assert.equal(health.classify(vm.runInNewContext('('+health.probe.toString()+')()',context)),'content');
  context.document.body=null;
  context.document.querySelector=()=>({});
  assert.equal(health.classify(vm.runInNewContext('('+health.probe.toString()+')()',context)),'login');
  assert.deepEqual(Object.keys(result).sort(),['blank','bodyChildren','login','ready','root','scripts']);
});
