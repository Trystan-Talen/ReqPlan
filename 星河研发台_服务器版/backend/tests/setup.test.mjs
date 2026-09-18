import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {randomBytes} from 'node:crypto';
import {openDatabase} from '../database.mjs';
import {importLegacy} from '../scripts/import-legacy.mjs';
import {createApplication} from '../server.mjs';

function fixture(t,options={}){
  const db=openDatabase(':memory:');importLegacy(db);
  const setupToken=randomBytes(32).toString('base64url');
  const logs=[];
  const app=createApplication({db,publicOrigin:'http://127.0.0.1:45678',secureCookies:false,setupToken,logger:{info:v=>logs.push(v),error:v=>logs.push(v)},...options});
  t.after(()=>db.close());
  async function call(url,{method='GET',body,headers={},beforeBody}={}){
    const req=new PassThrough();req.url=url;req.method=method;req.headers={...(body?{'content-type':'application/json'}:{}),...headers};req.socket={remoteAddress:'test'};
    let finish;const result=new Promise(resolve=>finish=resolve);const responseHeaders=new Headers();
    const res={statusCode:200,headersSent:false,setHeader(k,v){responseHeaders.set(k,v);},writeHead(status,values){this.statusCode=status;this.headersSent=true;for(const[k,v]of Object.entries(values||{}))responseHeaders.set(k,v);},end(content){finish({status:this.statusCode,headers:responseHeaders,data:JSON.parse(content)});}};
    const handling=app.handler(req,res);
    if(beforeBody)await beforeBody();
    req.end(body?JSON.stringify(body):undefined);
    await handling;return result;
  }
  const input={username:'manager',name:'项目管理员',password:'A1b2c3',setupToken};
  return {db,app,setupToken,logs,input,call};
}

test('初始化状态不向匿名请求暴露真实账号建议或设置凭证',async t=>{
  const f=fixture(t);
  assert.deepEqual((await f.call('/api/setup/status')).data,{required:true,enabled:true});
  const allowed=await f.call('/api/setup/status',{headers:{'x-setup-token':f.setupToken}});
  assert.equal(allowed.data.suggestedUsername,'admin');assert.ok(allowed.data.suggestedName);
  assert.doesNotMatch(JSON.stringify(allowed.data),new RegExp(f.setupToken));
  const wrong=await f.call('/api/setup/admin',{method:'POST',body:{...f.input,setupToken:'bad'}});
  assert.equal(wrong.status,403);assert.equal(f.db.prepare("SELECT count(*) n FROM users WHERE role='admin'").get().n,0);
});

test('网页接受6位密码初始化原管理员并自动登录，保留原项目身份',async t=>{
  const f=fixture(t);
  const result=await f.call('/api/setup/admin',{method:'POST',body:f.input});assert.equal(result.status,201,JSON.stringify(result.data));
  assert.equal(result.data.user.id,'u-manager');assert.equal(result.data.user.role,'admin');assert.ok(result.data.csrfToken);
  assert.match(result.headers.get('set-cookie'),/HttpOnly/);
  assert.deepEqual((await f.call('/api/setup/status',{headers:{'x-setup-token':f.setupToken}})).data,{required:false,enabled:false});
  assert.equal(f.db.prepare('SELECT count(*) n FROM users').get().n,6);
  assert.equal(f.db.prepare('SELECT count(*) n FROM requirements').get().n,55);
  assert.equal(f.db.prepare('SELECT count(*) n FROM tasks').get().n,79);
  const repeated=await f.call('/api/setup/admin',{method:'POST',body:{...f.input,password:'other6'}});assert.equal(repeated.status,409);
  assert.equal((await f.app.auth.login({username:'manager',password:f.input.password,ip:'test'})).user.id,'u-manager');
  for(const line of f.logs){assert.ok(!line.includes(f.setupToken));assert.ok(!line.includes(f.input.password));}
});

test('初始化拒绝5位密码、跨站请求与过期入口',async t=>{
  let now=1000;const f=fixture(t,{now:()=>now,setupTtlMs:1000});
  const short=await f.call('/api/setup/admin',{method:'POST',body:{...f.input,password:'12345'}});assert.equal(short.status,400);
  const cross=await f.call('/api/setup/admin',{method:'POST',body:f.input,headers:{origin:'https://other.invalid'}});assert.equal(cross.status,403);
  now=2001;const expired=await f.call('/api/setup/admin',{method:'POST',body:f.input});assert.equal(expired.status,403);
  assert.equal(expired.data.code,'SETUP_DISABLED');
});

test('两个同时初始化的请求只成功一次',async t=>{
  const f=fixture(t);
  const results=await Promise.all([f.call('/api/setup/admin',{method:'POST',body:f.input}),f.call('/api/setup/admin',{method:'POST',body:f.input})]);
  assert.deepEqual(results.map(r=>r.status).sort(),[201,409]);
  assert.equal(results.find(r=>r.status===409).data.code,'SETUP_COMPLETE');
  assert.equal(f.db.prepare("SELECT count(*) n FROM users WHERE role='admin'").get().n,1);
});

test('读取请求正文期间完成初始化，旧请求返回已完成而非服务错误',async t=>{
  const f=fixture(t);
  const delayed=await f.call('/api/setup/admin',{method:'POST',body:f.input,beforeBody:async()=>{
    const winner=await f.call('/api/setup/admin',{method:'POST',body:f.input});assert.equal(winner.status,201);
  }});
  assert.equal(delayed.status,409);assert.equal(delayed.data.code,'SETUP_COMPLETE');
});

test('未配置初始化凭证时，网页不能抢先建立管理员',async t=>{
  const f=fixture(t,{setupToken:''});
  assert.deepEqual((await f.call('/api/setup/status')).data,{required:true,enabled:false});
  assert.equal((await f.call('/api/setup/admin',{method:'POST',body:f.input})).status,403);
});
