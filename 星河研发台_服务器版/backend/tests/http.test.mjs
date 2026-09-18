import test from 'node:test';
import {PassThrough} from 'node:stream';
import assert from 'node:assert/strict';
import {openDatabase} from '../database.mjs';
import {createApplication} from '../server.mjs';

const password='Test-only-9!River-2026';
async function fixture(t){
  const db=openDatabase(':memory:');
  const app=createApplication({db,publicOrigin:'http://127.0.0.1:3000',secureCookies:false,instanceId:'http-test-instance',logger:{info(){},error(){}}});
  await app.auth.bootstrapAdmin({username:'admin-test',name:'测试管理员',password});
  const socketMode=process.env.XINGHE_HTTP_SOCKET==='1';
  let base;
  if(socketMode){
    await new Promise((resolve,reject)=>{app.server.once('error',reject);app.server.listen(0,'127.0.0.1',resolve);});
    base=`http://127.0.0.1:${app.server.address().port}`;
  }
  t.after(async()=>{if(socketMode)await new Promise(resolve=>app.server.close(resolve));db.close();});
  async function call(url,{method='GET',body,cookie,csrf,origin,headers={}}={}){
    const requestHeaders={...(body?{'content-type':'application/json'}:{}),...(cookie?{cookie}:{}),...(csrf?{'x-csrf-token':csrf}:{}),...(origin?{origin}:{}),...Object.fromEntries(Object.entries(headers).map(([k,v])=>[k.toLowerCase(),v]))};
    if(socketMode){
      const res=await fetch(base+url,{method,headers:requestHeaders,body:body?JSON.stringify(body):undefined});
      const text=await res.text();let data;try{data=JSON.parse(text);}catch{data=text;}return{res,data};
    }
    const req=new PassThrough();req.url=url;req.method=method;req.headers=requestHeaders;req.socket={remoteAddress:'127.0.0.1'};
    return await new Promise((resolve,reject)=>{
      const responseHeaders=new Headers();
      const res={statusCode:200,headersSent:false,setHeader(k,v){responseHeaders.set(k,v);},writeHead(status,values){this.statusCode=status;this.headersSent=true;for(const[k,v]of Object.entries(values||{}))responseHeaders.set(k,v);},end(value){let data=Buffer.isBuffer(value)?value.toString('utf8'):String(value||'');try{data=JSON.parse(data);}catch{}resolve({res:{status:this.statusCode,headers:responseHeaders},data});}};
      app.handler(req,res).catch(reject);req.end(body?JSON.stringify(body):undefined);
    });
  }
  const login=await call('/api/auth/login',{method:'POST',body:{username:'admin-test',password}});
  assert.equal(login.res.status,200,JSON.stringify(login.data));
  const cookie=login.res.headers.get('set-cookie').split(';')[0],csrf=login.data.csrfToken;
  const write=(url,body,method='POST')=>call(url,{method,body,cookie,csrf});
  return {...app,db,call,write,cookie,csrf,login};
}

test('接口认证、来源校验、防跨站请求与响应脱敏',async t=>{
  const f=await fixture(t);
  const health=await f.call('/api/health');assert.equal(health.res.status,200);assert.equal(health.data.instanceId,'http-test-instance');
  assert.equal((await f.call('/api/bootstrap')).res.status,401);
  assert.match(f.login.res.headers.get('set-cookie'),/HttpOnly/i);
  assert.match(f.login.res.headers.get('set-cookie'),/SameSite=Strict/i);
  assert.equal((await f.call('/api/projects',{method:'POST',body:{name:'项目'},cookie:f.cookie})).res.status,403);
  assert.equal((await f.call('/api/bootstrap',{cookie:f.cookie,origin:'https://evil.invalid'})).res.status,403);
  const boot=await f.call('/api/bootstrap',{cookie:f.cookie});assert.equal(boot.res.status,200);
  assert.doesNotMatch(JSON.stringify(boot.data),/password_hash|token_hash|password"/);
  const unsupported=await f.call('/api/auth/login',{method:'POST',body:{username:'x'},headers:{'Content-Type':'text/plain'}});assert.equal(unsupported.res.status,415);
  const logout=await f.write('/api/auth/logout',{});assert.equal(logout.res.status,200);
  assert.equal((await f.call('/api/auth/me',{cookie:f.cookie})).res.status,401);
});

test('真实服务完成项目、需求、任务、乐观锁和附件闭环',async t=>{
  const f=await fixture(t);
  const p=await f.write('/api/projects',{name:'服务器验收项目',status:'进行中',description:'持久化写入'});assert.equal(p.res.status,201,JSON.stringify(p.data));
  const r=await f.write('/api/requirements',{projectId:p.data.id,title:'验收需求',description:'原始正文',priority:'P1',status:'未确定',acceptance:'可保存并读取'});assert.equal(r.res.status,201,JSON.stringify(r.data));
  const task=await f.write('/api/tasks',{projectId:p.data.id,requirementId:r.data.id,title:'验收任务',status:'wait',estimateHours:8});assert.equal(task.res.status,201,JSON.stringify(task.data));
  const competing=await Promise.all([
    f.write('/api/requirements/'+r.data.id,{version:r.data.version,title:'修改一'},'PATCH'),
    f.write('/api/requirements/'+r.data.id,{version:r.data.version,title:'修改二'},'PATCH')
  ]);assert.deepEqual(competing.map(x=>x.res.status).sort(),[200,409]);
  const file=await f.write(`/api/requirements/${r.data.id}/attachments`,{name:'验收文档.html',mime:'text/html',content:Buffer.from('<h1>验收文档</h1>').toString('base64')});assert.equal(file.res.status,201,JSON.stringify(file.data));
  const download=await f.call('/api/attachments/'+file.data.id,{cookie:f.cookie});assert.equal(download.res.status,200,JSON.stringify(download.data));
  assert.match(download.res.headers.get('content-disposition'),/^attachment;/);assert.match(download.res.headers.get('content-security-policy'),/sandbox/);
  assert.equal(download.data,'<h1>验收文档</h1>');
  const history=await f.call(`/api/requirements/${r.data.id}/history`,{cookie:f.cookie});assert.equal(history.res.status,200,JSON.stringify(history.data));assert.ok(history.data.entries.length>=2);
});

test('管理员开户、一次性激活、项目只读权限及停用生效',async t=>{
  const f=await fixture(t);
  const created=await f.write('/api/users',{username:'member-test',name:'验收成员',role:'member'});assert.equal(created.res.status,201,JSON.stringify(created.data));
  assert.ok(created.data.activationToken);
  const activated=await f.call('/api/auth/activate',{method:'POST',body:{token:created.data.activationToken,password}});assert.equal(activated.res.status,200,JSON.stringify(activated.data));
  assert.ok((await f.call('/api/auth/activate',{method:'POST',body:{token:created.data.activationToken,password}})).res.status>=400);
  const p=await f.write('/api/projects',{name:'只读权限验收'});assert.equal(p.res.status,201,JSON.stringify(p.data));
  const membership=await f.write(`/api/projects/${p.data.id}/members`,{userId:created.data.user.id,role:'viewer',version:p.data.version},'PUT');assert.equal(membership.res.status,200,JSON.stringify(membership.data));
  const login=await f.call('/api/auth/login',{method:'POST',body:{username:'member-test',password}});assert.equal(login.res.status,200);
  const cookie=login.res.headers.get('set-cookie').split(';')[0],csrf=login.data.csrfToken;
  assert.equal((await f.call('/api/users',{cookie})).res.status,403);
  const rejected=await f.call('/api/requirements',{method:'POST',cookie,csrf,body:{projectId:p.data.id,title:'拒绝只读写入'}});assert.equal(rejected.res.status,403,JSON.stringify(rejected.data));
  const disabled=await f.write('/api/users/'+created.data.user.id,{status:'disabled'},'PATCH');assert.equal(disabled.res.status,200);
  assert.equal((await f.call('/api/auth/me',{cookie})).res.status,401);
});
