import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createWebServer } from '../../dist/src/web/server.mjs';
import { createSessionStore } from '../../dist/src/storage/session-store.mjs';
import { createWorkflowSession } from '../../dist/src/state-machine/workflow-session.mjs';

const plan = JSON.parse(readFileSync(new URL('../../fixtures/observed/run8-原因版提示词/turn-2.plan.json', import.meta.url)));
const reply = () => ({role:'assistant', content:'已规划', tool_calls:[{id:'saved-plan',type:'function',function:{name:'propose_plan',arguments:JSON.stringify(plan)}}]});
const execute = async ({step,canvas}) => canvas.nodes.some(n=>n.step===step.ref) ? {kind:'covered'} : {
  kind:'patch', nodes:[{name:step.ref,step:step.ref,type:'code',params:{code:'return items;',outputKind:'JSON'},blanks:[]}],
  edges:step.dependsOn.map(from=>({from,to:step.ref}))};
const revision = context => ({kind:'patch',summary:'修改已保存',review:context.plan.steps.map(s=>({step:s.ref,summary:'保持整条链成立'})),
  upsertNodes:context.canvas.nodes.filter(n=>n.name==='s2').map(n=>({...n,note:'已修改'})),removeNodes:[],addEdges:[],removeEdges:[]});
const temp = t => { const dir=mkdtempSync(join(tmpdir(),'canvas-sessions-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir; };
async function serve(t, directory, options={}) {
  const server=await createWebServer({storageDir:directory,callModel:async()=>reply(),executor:execute,reviser:async c=>revision(c),...options});
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  const base=`http://127.0.0.1:${server.address().port}`;
  let closed=false;
  const close=async()=>{if(closed)return;closed=true;server.closeAllConnections();await new Promise(r=>server.close(r));};
  t.after(close);
  const req=async(path,method='GET',data)=>{const res=await fetch(base+path,{method,headers:{'content-type':'application/json'},...(data?{body:JSON.stringify(data)}:{})});return {status:res.status,data:await res.json()};};
  const id=(await req('/api/sessions')).data.sessions[0].id;
  const state=async(target=id)=>(await req(`/api/sessions/${target}/state`)).data;
  const action=(name,data,target=id)=>req(`/api/sessions/${target}/${name}`,'POST',data);
  const until=async(fn)=>{for(let i=0;i<100;i++){const result=await fn();if(result)return result;await new Promise(r=>setTimeout(r,5));}throw new Error('会话状态未收尾');};
  const build=async()=>{await action('say',{text:'合同工作流'});await action('start');return until(async()=>{const s=await state();return s.run?.endedBy==='finished'&&s;});};
  return {req,id,state,action,build,until,close};
}

test('重启恢复方案上下文、配置、记录，继续修订能读到原来的要求',async t=>{
  const dir=temp(t);const first=await serve(t,dir);await first.build();
  await first.action('note',{step:'s2',text:'保留合同原文'});
  let state=await first.state();
  assert.equal((await first.action('configure',{node:'s2',key:'code',value:'return items.map(x => x);',canvasVersion:state.canvas.version})).status,200);
  state=await first.state();
  await first.action('revise',{node:'s2',step:'s2',canvasVersion:state.canvas.version,text:'保留整数金额'});
  await first.until(async()=>!['processing','checking'].includes((await first.state()).edits.at(-1)?.status));
  const before=await first.state();
  assert.equal((await first.req('/api/reset','POST')).status,409);
  assert.equal((await first.req('/api/say','POST',{text:'旧标签页的请求'})).status,409);
  assert.deepEqual((await first.state()).canvas,before.canvas);
  const stored=JSON.parse(readFileSync(join(dir,`${first.id}.json`),'utf8'));
  assert.ok(stored.workflow.plan.transcript.some(m=>m.tool_calls));
  await first.close();
  let context, messages;
  const second=await serve(t,dir,{reviser:async c=>{context=c;return {kind:'unchanged',summary:'不需修改',review:c.plan.steps.map(s=>({step:s.ref,summary:'继续成立'}))};},callModel:async args=>{messages=args;return {role:'assistant',content:'可以继续'};}});
  const after=await second.state();
  for(const key of ['canvas','plan','chat','edits','annotations','revision','canvasPlanRevision','run']) assert.deepEqual(after[key],before[key],key);
  await second.action('revise',{node:'s2',step:'s2',canvasVersion:after.canvas.version,text:'检查整条工作流'});
  await second.until(async()=>(await second.state()).edits.length===2&&(await second.state()).turn==='user');
  assert.equal(context.requirements[0].text,'保留整数金额');
  assert.equal(context.history.runs.length,1);
  assert.equal(context.annotations[0].text,'保留合同原文');
  assert.equal(context.canvas.nodes.find(n=>n.name==='s2').params.code,'return items.map(x => x);');
  await second.action('say',{text:'继续解释'});
  assert.ok(messages.some(m=>m.tool_calls));
  assert.ok(messages.some(m=>m.content==='合同工作流'));
});

test('新建与切换不会中断原会话，迟到的修订只写回自己的会话',async t=>{
  let finish;const api=await serve(t,temp(t),{reviser:c=>new Promise(r=>{finish=()=>r(revision(c));})});
  const before=await api.build();
  await api.action('revise',{node:'s2',step:'s2',canvasVersion:before.canvas.version,text:'A 的修改'});
  const b=(await api.req('/api/sessions','POST')).data.id;
  assert.equal((await api.state(b)).turn,'user');
  assert.equal((await api.state()).turn,'revision');
  await api.action('say',{text:'B 的工作流'},b);
  finish();await api.until(async()=>(await api.state()).turn==='user');
  assert.equal((await api.state()).edits[0].status,'applied');
  assert.deepEqual((await api.state(b)).edits,[]);
  assert.equal((await api.state(b)).task,'B 的工作流');
});

test('改名、删除和恢复在重启后保留，失效的会话地址不落到其他会话',async t=>{
  const dir=temp(t);const api=await serve(t,dir);await api.build();
  await api.req(`/api/sessions/${api.id}`,'PATCH',{title:'我的合同流程'});
  const b=(await api.req('/api/sessions','POST')).data.id;
  await api.req(`/api/sessions/${api.id}`,'DELETE');
  assert.equal((await api.action('say',{text:'迟来的修改'})).status,410);
  await api.close();
  const restored=await serve(t,dir);
  const list=(await restored.req('/api/sessions')).data;
  assert.equal(list.sessions[0].id,b);assert.equal(list.trash[0].title,'我的合同流程');
  await restored.req(`/api/sessions/${api.id}/restore`,'POST');
  assert.equal((await restored.state(api.id)).canvas.nodes.length,plan.steps.length);
  assert.equal((await restored.req('/api/sessions/not-a-real-id/say','POST',{text:'丢失'})).status,404);
});

test('执行中断恢复最后已提交步骤，规划中断保留用户原话但不会自动重试',async t=>{
  let resolveStep;const running=createWorkflowSession({callModel:async()=>reply(),executor:async c=>c.step.ref==='s2'?new Promise(r=>{resolveStep=()=>r({kind:'covered'});}):execute(c)});
  await running.say('原始需求');const pending=running.start();
  while(!resolveStep) await new Promise(r=>setTimeout(r,1));
  const saved=running.exportState();assert.equal(saved.activeRun.steps.length,1);
  const recovered=createWorkflowSession({callModel:async()=>{throw new Error('不应自动调用');},savedState:saved});
  assert.equal(recovered.turn,'user');assert.equal(recovered.canvas.nodes.length,1);
  assert.equal(recovered.runs.at(-1).endedBy,'interrupted');
  running.stop();resolveStep();await pending;
  let resolvePlan;const planning=createWorkflowSession({callModel:()=>new Promise(r=>{resolvePlan=r;})});
  const saying=planning.say('未完成的需求');const planState=planning.exportState();
  assert.equal(planState.turn,'plan');assert.equal(planState.plan.transcript.at(-1).content,'未完成的需求');
  const record={formatVersion:1,id:'interrupted',title:'中断',updatedAt:new Date().toISOString(),workflow:planState,presentation:{task:'未完成的需求',chat:[{who:'user',text:'未完成的需求'}]},notice:''};
  const dir=temp(t);createSessionStore(dir).save(record);
  const api=await serve(t,dir);const state=await api.state();assert.equal(state.turn,'user');assert.match(state.notice,/中断/);
  resolvePlan({role:'assistant',content:'测试收尾'});await saying;
});

test('处理中断的整图修订不应用半份修改，原始要求仍能找到',async()=>{
  const session=createWorkflowSession({callModel:async()=>reply(),executor:execute,reviser:()=>new Promise(()=>{})});
  await session.say('合同');await session.start();
  const before=session.canvas;
  const pending=session.revise({node:'s2',step:'s2',canvasVersion:before.version,text:'我的修改'});
  const restored=createWorkflowSession({callModel:async()=>reply(),savedState:session.exportState()});
  assert.deepEqual(restored.canvas,before);assert.equal(restored.turn,'user');assert.equal(restored.edits[0].status,'stopped');assert.equal(restored.edits[0].text,'我的修改');
  session.stop();await pending;
});

test('损坏存档原样保留并提示；保存失败不能显示为已保存',async t=>{
  const dir=temp(t);writeFileSync(join(dir,'broken.json'),'{bad');
  const api=await serve(t,dir);assert.equal((await api.req('/api/sessions')).data.warnings.length,1);
  assert.equal(readFileSync(join(dir,'broken.json'),'utf8'),'{bad');
  assert.ok(readdirSync(dir).every(n=>!n.endsWith('.tmp')));
  const backing=createSessionStore(null);let fail=false;
  const bad=await serve(t,null,{store:{...backing,save(record){if(fail)throw new Error('disk full');backing.save(record);}}});
  fail=true;await bad.action('say',{text:'请保存'});
  assert.match((await bad.state()).storageError,/保存失败/);assert.equal((await bad.state()).savedAt,null);
  assert.equal((await bad.action('say',{text:'继续'})).status,503);
  fail=false;assert.equal((await bad.action('save')).status,200);assert.equal((await bad.state()).storageError,'');
});

test('创建时保存名称，首次需求与重启不会覆盖，非法名称不创建会话',async t=>{
  const dir=temp(t),api=await serve(t,dir);
  const count=(await api.req('/api/sessions')).data.sessions.length;
  for (const title of ['', '   ', '名'.repeat(81), 42, null]) {
    assert.equal((await api.req('/api/sessions','POST',{title})).status,400);
  }
  assert.equal((await api.req('/api/sessions')).data.sessions.length,count);
  const created=await api.req('/api/sessions','POST',{title:'  PDF 资料整理  '});
  assert.equal(created.status,201);
  const id=created.data.id;
  assert.equal((await api.state(id)).title,'PDF 资料整理');
  await api.action('say',{text:'扫描文档处理'},id);
  assert.equal((await api.state(id)).title,'PDF 资料整理');
  const untitled=await api.req('/api/sessions','POST');
  assert.equal((await api.state(untitled.data.id)).title,'新工作流');
  const oldFeedId=(await api.state(id)).feedId;
  await api.close();
  const restored=await serve(t,dir);
  assert.notEqual((await restored.state(id)).feedId, oldFeedId);
  assert.equal((await restored.state(id)).title,'PDF 资料整理');
});
