import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {prepareLocalData,validateLocalPorts,launchLocal,writeLocalState,removeLocalState} from '../../deploy/launch-local.mjs';
import {listenWithFallback,startDev} from '../../deploy/dev.mjs';
import {openDatabase} from '../database.mjs';
import {createAuth} from '../auth.mjs';

test('本机首次启动导入真实项目，复跑保留已有编辑和管理员',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xinghe-launch-'));
  const file=path.join(dir,'data.sqlite');
  try{
    const first=prepareLocalData(file);
    assert.deepEqual([first.projects,first.requirements,first.tasks],[3,55,79]);
    assert.equal(first.imported,true);assert.equal(first.needsAdmin,true);assert.equal(first.admin.username,'manager');
    const db=openDatabase(file);
    try{
      await createAuth(db).bootstrapAdmin({username:first.admin.username,name:first.admin.name,password:'Local-Launcher-Test!2026'});
      const row=db.prepare("SELECT data FROM projects WHERE id='p-exec'").get();
      const data=JSON.parse(row.data);data.description='启动前已有的真实编辑';
      db.prepare("UPDATE projects SET data=? WHERE id='p-exec'").run(JSON.stringify(data));
    }finally{db.close();}
    const second=prepareLocalData(file);assert.equal(second.imported,false);assert.equal(second.needsAdmin,false);
    const reopened=openDatabase(file);
    try{assert.equal(JSON.parse(reopened.prepare("SELECT data FROM projects WHERE id='p-exec'").get().data).description,'启动前已有的真实编辑');}finally{reopened.close();}
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('默认请求系统空闲端口，允许显式端口，仅拒绝非法数值',()=>{
  assert.deepEqual(validateLocalPorts({}),{web:0,api:0});
  assert.deepEqual(validateLocalPorts({WEB_PORT:'8400',API_PORT:'8400'}),{web:8400,api:8400});
  for(const env of [{WEB_PORT:'-1'},{WEB_PORT:'65536'},{API_PORT:'abc'},{API_PORT:'3.5'}])assert.throws(()=>validateLocalPorts(env),/整数/);
});

class FakeServer extends EventEmitter {
  constructor(results=[43127]){super();this.results=results;this.calls=[];this.listening=false;this.closed=false;}
  listen(port,host){this.calls.push({port,host});queueMicrotask(()=>{const result=this.results.shift();if(typeof result==='string')this.emit('error',Object.assign(new Error('模拟监听错误'),{code:result}));else{this.port=result;this.listening=true;this.emit('listening');}});return this;}
  address(){return {port:this.port};}
  close(callback){this.closed=true;this.listening=false;queueMicrotask(()=>callback?.());}
  closeAllConnections(){}
}
class FakeChild extends EventEmitter {
  constructor(){super();this.pid=24680;this.exitCode=null;this.signalCode=null;this.signals=[];}
  kill(signal){this.signals.push(signal);queueMicrotask(()=>{this.exitCode=0;this.signalCode=signal;this.emit('exit',0,signal);});return true;}
}
const baseState={imported:false,projects:3,requirements:55,tasks:79,needsAdmin:true,admin:{username:'manager'}};
const message=(child,value)=>queueMicrotask(()=>child.emit('message',value));

test('只在显式端口被占用时回退一次；环境禁止监听不重试',async()=>{
  const occupied=new FakeServer(['EADDRINUSE',41002]);
  assert.equal(await listenWithFallback(occupied,8400),41002);
  assert.deepEqual(occupied.calls.map(v=>v.port),[8400,0]);
  const denied=new FakeServer(['EPERM']);
  await assert.rejects(listenWithFallback(denied,8400),{code:'EPERM'});
  assert.deepEqual(denied.calls.map(v=>v.port),[8400]);
  const automatic=new FakeServer(['EADDRINUSE']);
  await assert.rejects(listenWithFallback(automatic,0),{code:'EADDRINUSE'});
  assert.equal(automatic.calls.length,1);
});

test('先获得网页端口，再向独立接口传真实来源，并只接受同实例就绪',async()=>{
  const server=new FakeServer([42123]),sent=[],spawns=[];
  const running=await startDev({env:{XINGHE_LOCAL_RUN_ID:'instance-test',XINGHE_SETUP_TOKEN:'memory-only'},createServer:()=>server,send:value=>sent.push(value),spawnProcess:(command,args,options)=>{
    assert.equal(server.listening,true);spawns.push(options);
    const child=new FakeChild();
    message(child,{type:'api-ready',instanceId:'wrong-instance',port:49999});
    message(child,{type:'api-ready',instanceId:'instance-test',port:42124});return child;
  }});
  assert.equal(spawns[0].env.PUBLIC_ORIGIN,'http://127.0.0.1:42123');
  assert.equal(spawns[0].env.PORT,'0');assert.equal(spawns[0].env.XINGHE_SETUP_TOKEN,'memory-only');
  assert.equal(spawns[0].stdio.at(-1),'ipc');
  assert.deepEqual(sent,[{type:'ready',url:'http://127.0.0.1:42123',apiPort:42124,instanceId:'instance-test'}]);
  await running.stop();assert.equal(server.closed,true);assert.deepEqual(running.child.signals,['SIGTERM']);
});

test('接口显式端口冲突只回退系统分配，EPERM 立即关闭网页与子进程',async()=>{
  for(const code of ['EADDRINUSE','EPERM']){
    const server=new FakeServer(),ports=[],children=[];
    const promise=startDev({env:{API_PORT:'8444',XINGHE_LOCAL_RUN_ID:'ports-test'},createServer:()=>server,send:()=>{},spawnProcess:(command,args,options)=>{
      ports.push(options.env.PORT);const child=new FakeChild();children.push(child);
      message(child,ports.length===1?{type:'api-error',code,instanceId:'ports-test'}:{type:'api-ready',port:43128,instanceId:'ports-test'});return child;
    }});
    if(code==='EPERM'){await assert.rejects(promise,{code});assert.deepEqual(ports,['8444']);}
    else{const running=await promise;assert.deepEqual(ports,['8444','0']);await running.stop();}
    assert.equal(server.closed,true);assert.equal(children.every(child=>child.signals.includes('SIGTERM')),true);
  }
});

function launchOptions(extra={}) {
  const capture={logs:[],states:[],opened:[],removed:[],spawned:[]};
  const options={env:{},prepare:()=>({...baseState}),makeInstanceId:()=> 'launch-instance',makeToken:()=> 'A'.repeat(43),logger:{info:value=>capture.logs.push(value)},writeState:value=>capture.states.push(value),removeState:value=>capture.removed.push(value),openUrl:async value=>capture.opened.push(value),spawnProcess:(command,args,options)=>{
    capture.spawned.push({command,args,...options});const child=new FakeChild();capture.child=child;
    message(child,{type:'ready',url:'http://127.0.0.1:44201',apiPort:44202,instanceId:'unrelated-instance'});
    message(child,{type:'ready',url:'http://127.0.0.1:44201',apiPort:44202,instanceId:'launch-instance'});return child;
  },...extra};
  return {options,capture};
}

test('首次初始化令牌只传环境与浏览器片段，不记录日志或状态',async()=>{
  const {options,capture}=launchOptions();const running=await launchLocal(options);
  assert.equal(capture.spawned[0].env.XINGHE_SETUP_TOKEN,'A'.repeat(43));
  assert.equal(capture.spawned[0].env.WEB_PORT,'0');assert.equal(capture.spawned[0].env.API_PORT,'0');
  assert.equal(capture.opened[0],'http://127.0.0.1:44201/#setup='+'A'.repeat(43));
  assert.equal(capture.states[0].webPort,44201);assert.equal(capture.states[0].apiPort,44202);
  assert.equal(capture.states[0].pid,24680);assert.equal(capture.states[0].instanceId,'launch-instance');
  assert.equal(JSON.stringify({logs:capture.logs,states:capture.states,result:{url:running.url}}).includes('A'.repeat(43)),false);
  await running.stop();assert.deepEqual(capture.removed,['launch-instance']);
});

test('已有管理员不生成初始化令牌、清除继承令牌且不运行账号命令',async()=>{
  const {options,capture}=launchOptions({env:{XINGHE_SETUP_TOKEN:'stale-token'},prepare:()=>({...baseState,needsAdmin:false}),makeToken:()=>{throw new Error('不可调用');}});
  const running=await launchLocal(options);
  assert.equal(capture.spawned.length,1);assert.deepEqual(capture.spawned[0].args,['deploy/dev.mjs']);
  assert.equal(capture.spawned[0].env.XINGHE_SETUP_TOKEN,'');assert.equal(capture.opened[0],'http://127.0.0.1:44201');
  await running.stop();
});

test('就绪超时、启动错误和异常地址均不打开浏览器并清理子进程',async()=>{
  for(const mode of ['timeout','error','bad-url']){
    const child=new FakeChild();let opened=false,written=false;
    const {options}=launchOptions({timeoutMs:5,openUrl:async()=>{opened=true;},writeState:()=>{written=true;},spawnProcess:()=>{
      if(mode==='error')message(child,{type:'error',instanceId:'launch-instance',code:'EPERM'});
      if(mode==='bad-url')message(child,{type:'ready',instanceId:'launch-instance',url:'http://127.0.0.1:44201/#unexpected',apiPort:44202});
      return child;
    }});
    await assert.rejects(launchLocal(options));assert.equal(opened,false);assert.equal(written,false);assert.deepEqual(child.signals,['SIGTERM']);
  }
});

test('服务就绪后子进程异常退出传播失败状态',async()=>{
  const {options,capture}=launchOptions();const running=await launchLocal(options);
  capture.child.exitCode=7;capture.child.emit('exit',7);
  assert.equal(await running.closed,7);assert.deepEqual(capture.removed,['launch-instance']);
});

test('状态文件只有运行信息，停止旧实例不删除新实例状态',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xinghe-state-')),file=path.join(dir,'local-server.json');
  try{
    const state={url:'http://127.0.0.1:44001',webPort:44001,apiPort:44002,pid:123,instanceId:'safe-instance'};
    writeLocalState(state,file);assert.deepEqual(JSON.parse(fs.readFileSync(file,'utf8')),state);
    assert.equal(fs.statSync(file).mode&0o777,0o600);
    removeLocalState('older-instance',file);assert.equal(fs.existsSync(file),true);
    removeLocalState('safe-instance',file);assert.equal(fs.existsSync(file),false);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('独立开发入口为接口生成并传递实例编号',async()=>{
  let instanceId;
  const running=await startDev({env:{},createServer:()=>new FakeServer(),send:()=>{},spawnProcess:(command,args,options)=>{
    instanceId=options.env.XINGHE_LOCAL_RUN_ID;const child=new FakeChild();message(child,{type:'api-ready',instanceId,port:43128});return child;
  }});
  assert.match(instanceId,/^[a-f0-9-]{36}$/);assert.equal(running.instanceId,instanceId);await running.stop();
});

test('等待网页或接口就绪期间取消时清理已启动资源',async()=>{
  for(const stage of ['web','api']){
    const controller=new AbortController(),server=new FakeServer();let child;
    if(stage==='web')server.listen=function(port,host){this.calls.push({port,host});queueMicrotask(()=>{controller.abort();this.port=43127;this.listening=true;this.emit('listening');});return this;};
    const promise=startDev({env:{},signal:controller.signal,createServer:()=>server,send:()=>{},spawnProcess:()=>{
      child=new FakeChild();queueMicrotask(()=>controller.abort());return child;
    }});
    await assert.rejects(promise,{code:'ABORT_ERR'});assert.equal(server.closed,true);
    if(child)assert.deepEqual(child.signals,['SIGTERM']);
  }
});
