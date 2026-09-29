import http from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID,createHash,timingSafeEqual} from 'node:crypto';
import {openDatabase} from './database.mjs';
import {createAuth} from './auth.mjs';
import {createBusiness} from './business.mjs';
import {createProposalService} from './proposals.mjs';
import {createWorkService} from './work-service.mjs';
import {startBackupService} from './scripts/backup-service.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
function fail(status, code, message) { return Object.assign(new Error(message), {status, code}); }
const WRITE = new Set(['POST','PUT','PATCH','DELETE']);
async function readJson(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type'] || ''))) throw fail(415,'JSON_REQUIRED','请使用 JSON（结构化数据）请求。');
  if (Number(req.headers['content-length']) > 3*1024*1024) throw fail(413,'BODY_TOO_LARGE','请求内容超过 3 MB（兆字节）。');
  let length=0; const parts=[];
  for await (const part of req) { length+=part.length; if(length>3*1024*1024) throw fail(413,'BODY_TOO_LARGE','请求内容过大。'); parts.push(part); }
  let value; try { value=JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { throw fail(400,'INVALID_JSON','请求格式无效。'); }
  if(!value || typeof value!=='object' || Array.isArray(value)) throw fail(400,'INVALID_BODY','请求必须是一个对象。');
  return value;
}
function json(res,status,value,headers={}) { res.writeHead(status,{'Content-Type':'application/json; charset=utf-8',...headers});res.end(JSON.stringify(value)); }
function param(raw) { try { const value=decodeURIComponent(raw); if(!/^[a-zA-Z0-9_-]{1,100}$/.test(value)) throw 0;return value; } catch { throw fail(400,'INVALID_ID','记录编号无效。'); } }

export function createApplication({db,publicOrigin='http://127.0.0.1:3000',secureCookies=true,trustProxy=false,logger=console,instanceId=null,setupToken='',setupTtlMs=24*60*60*1000,now=()=>Date.now(),backupService=null}={}) {
  if(!db) throw new Error('需要数据库连接。');
  const origin=new URL(publicOrigin).origin;
  // A loopback-only origin is the same machine whether reached as 127.0.0.1 or localhost.
  const trustedOrigins=new Set([origin]);
  { const parsed=new URL(origin); const alias={'127.0.0.1':'localhost','localhost':'127.0.0.1'}[parsed.hostname]; if(alias){parsed.hostname=alias;trustedOrigins.add(parsed.origin);} }
  const auth=createAuth(db,{secureCookies});
  const business=createBusiness(db);
  const proposals=createProposalService(db,business);
  const work=createWorkService(db,business);
  if(setupToken && !/^[A-Za-z0-9_-]{43}$/.test(setupToken)) throw new Error('初始化凭证必须是 32 字节随机值的安全编码。');
  let setupHash=setupToken?createHash('sha256').update(setupToken).digest():null;
  const setupExpiresAt=now()+setupTtlMs;
  const needsSetup=()=>!db.prepare("SELECT 1 FROM users WHERE role='admin' LIMIT 1").get();
  const setupEnabled=()=>Boolean(setupHash && now()<setupExpiresAt && needsSetup());
  function validSetupToken(value) {
    return setupEnabled() && typeof value==='string' && /^[A-Za-z0-9_-]{43}$/.test(value) && timingSafeEqual(setupHash,createHash('sha256').update(value).digest());
  }
  const handler=async(req,res)=>{
    const requestId=randomUUID();
    res.setHeader('X-Request-Id',requestId);
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Cache-Control','no-store');
    res.setHeader('Referrer-Policy','no-referrer');
    const started=Date.now();
    let endpoint='unknown';
    try {
      const url=new URL(req.url,'http://localhost');endpoint=url.pathname;
      const method=req.method;
      if(req.headers.origin && !trustedOrigins.has(req.headers.origin)) throw fail(403,'ORIGIN_REJECTED','请求来源不受信任。');
      if(req.headers['sec-fetch-site']==='cross-site') throw fail(403,'ORIGIN_REJECTED','不接受跨站请求。');
      if(method==='GET' && endpoint==='/api/health') { db.prepare('SELECT 1').get();return json(res,200,{status:'ok',...(instanceId?{instanceId}:{})}); }
      const token=auth.tokenFromCookie(req.headers.cookie||'');
      const ip=trustProxy ? String(req.headers['x-real-ip']||req.socket.remoteAddress||'').slice(0,100) : req.socket.remoteAddress;
      if(method==='GET' && endpoint==='/api/setup/status') {
        const required=needsSetup();
        const original=required&&validSetupToken(req.headers['x-setup-token'])?db.prepare("SELECT username,name FROM users WHERE id='u-manager' AND status='pending' AND password_hash IS NULL").get():null;
        return json(res,200,{required,enabled:setupEnabled(),...(validSetupToken(req.headers['x-setup-token'])?{suggestedUsername:'admin',suggestedName:original?.name||'项目管理员'}:{})});
      }
      if(method==='POST' && endpoint==='/api/setup/admin') {
        if(!needsSetup()) throw fail(409,'SETUP_COMPLETE','管理员已经初始化，请直接登录。');
        if(!setupEnabled()) throw fail(403,'SETUP_DISABLED','初始化入口未启用或已过期，请从启动入口重新打开。');
        const input=await readJson(req);
        if(!needsSetup()) throw fail(409,'SETUP_COMPLETE','管理员已经初始化，请直接登录。');
        if(!setupEnabled()) throw fail(403,'SETUP_DISABLED','初始化入口未启用或已过期，请从启动入口重新打开。');
        if(!validSetupToken(input.setupToken))throw fail(403,'INVALID_SETUP_TOKEN','初始化链接无效，请使用启动器打开的页面。');
        try{await auth.bootstrapAdmin({username:input.username,name:input.name,password:input.password});}
        catch(error){if(error.code==='ADMIN_EXISTS')throw fail(409,'SETUP_COMPLETE','管理员已经初始化，请使用现有账号登录。');throw error;}
        setupHash=null;
        const session=await auth.login({username:input.username,password:input.password,ip});
        return json(res,201,{user:session.user,csrfToken:session.csrfToken,expiresAt:session.expiresAt},{'Set-Cookie':session.cookie});
      }
      if(method==='POST' && endpoint==='/api/auth/login') {
        const result=await auth.login({...await readJson(req),ip});
        return json(res,200,{user:result.user,csrfToken:result.csrfToken,expiresAt:result.expiresAt},{'Set-Cookie':result.cookie});
      }
      if(method==='POST' && endpoint==='/api/auth/activate') {
        const result=await auth.redeemToken(await readJson(req));
        return json(res,200,result);
      }
      const session=auth.authenticate(token);
      if(!session) throw fail(401,'UNAUTHENTICATED','请先登录，或重新登录已过期的会话。');
      const actor=session.user;
      if(method==='GET' && endpoint==='/api/auth/me') return json(res,200,session);
      if(WRITE.has(method) && !auth.verifyCsrf(token,String(req.headers['x-csrf-token']||''))) throw fail(403,'CSRF_REJECTED','安全校验失效，请刷新页面后重试。');
      if(method==='POST' && endpoint==='/api/auth/logout') {
        const result=auth.logout(token);return json(res,200,{ok:true},{'Set-Cookie':result.cookie});
      }
      if(method==='POST' && endpoint==='/api/auth/change-password') {
        await auth.changePassword(actor,await readJson(req),token);
        return json(res,200,{ok:true,requiresLogin:true},{'Set-Cookie':auth.clearCookie()});
      }
      if(actor.mustChangePassword) throw fail(403,'PASSWORD_CHANGE_REQUIRED','请先修改初始密码。');
      if(method==='GET' && endpoint==='/api/bootstrap') { const options={includeArchived:url.searchParams.get('includeArchived')==='1'};return json(res,200,{...business.bootstrap(actor,options),proposals:proposals.list(actor,options)}); }
      if(method==='GET' && endpoint==='/api/work') return json(res,200,work.snapshot(actor,url.searchParams.get('date')||undefined));
      if(method==='POST' && endpoint==='/api/work/read') return json(res,200,work.markRead(actor,await readJson(req)));
      if(endpoint==='/api/admin/backup-status' || endpoint==='/api/admin/backup-run') {
        if(actor.role!=='admin') throw fail(403,'FORBIDDEN','仅系统管理员可以查看和执行备份。');
        if(!backupService) throw fail(503,'BACKUP_UNAVAILABLE','备份服务尚未启动。');
        if(method==='GET' && endpoint.endsWith('backup-status')) return json(res,200,backupService.status());
        if(method==='POST' && endpoint.endsWith('backup-run')) {
          await readJson(req);
          if(!backupService.status().enabled) throw fail(409,'BACKUP_DISABLED','自动备份已关闭或配置无效，请检查服务器配置。');
          void backupService.runNow().catch(()=>logger.error({event:'backup_request_failed'}));
          return json(res,202,backupService.status());
        }
      }
      if(endpoint==='/api/users' && method==='GET') return json(res,200,{users:auth.listUsers(actor)});
      if(endpoint==='/api/users' && method==='POST') {
        const result=auth.createUser(actor,await readJson(req));
        return json(res,201,{user:result.user,activationToken:result.activation.token,expiresAt:result.activation.expiresAt});
      }
      let match;
      if(endpoint==='/api/proposals') {
        if(method==='GET') return json(res,200,{proposals:proposals.list(actor,{projectId:url.searchParams.get('projectId')||undefined,includeArchived:url.searchParams.get('includeArchived')==='1'})});
        if(method==='POST') return json(res,201,proposals.create(actor,await readJson(req)));
      }
      if((match=endpoint.match(/^\/api\/proposals\/([^/]+)\/history$/)) && method==='GET') return json(res,200,{entries:proposals.history(actor,param(match[1]))});
      if((match=endpoint.match(/^\/api\/proposals\/([^/]+)\/approve$/)) && method==='POST') return json(res,200,proposals.approve(actor,param(match[1]),await readJson(req)));
      if((match=endpoint.match(/^\/api\/proposals\/([^/]+)$/))) {
        const id=param(match[1]);
        if(method==='GET') return json(res,200,proposals.read(actor,id));
        if(method==='PATCH') return json(res,200,proposals.update(actor,id,await readJson(req)));
      }
      if((match=endpoint.match(/^\/api\/users\/([^/]+)\/reset-password$/)) && method==='POST') {
        const result=auth.resetPassword(actor,param(match[1]));
        return json(res,200,{user:result.user,activationToken:result.token,expiresAt:result.expiresAt});
      }
      if((match=endpoint.match(/^\/api\/users\/([^/]+)$/)) && method==='PATCH') return json(res,200,auth.updateUser(actor,param(match[1]),await readJson(req)));
      if(method==='GET' && endpoint==='/api/audit') {
        if(actor.role!=='admin') throw fail(403,'FORBIDDEN','仅系统管理员可以查看团队审计。');
        const before=Number(url.searchParams.get('before'))||Number.MAX_SAFE_INTEGER;
        return json(res,200,{entries:db.prepare('SELECT id,user_id,action,entity_type,entity_id,detail,created_at FROM audit WHERE id < ? ORDER BY id DESC LIMIT 100').all(before).map(row=>({id:row.id,userId:row.user_id,action:row.action,entityType:row.entity_type,entityId:row.entity_id,detail:JSON.parse(row.detail),createdAt:row.created_at}))});
      }
      if((match=endpoint.match(/^\/api\/projects\/([^/]+)\/members(?:\/([^/]+))?$/))) {
        const id=param(match[1]);
        if(method==='GET'&&!match[2]) return json(res,200,{members:business.listMembers(actor,id)});
        if(method==='PUT'&&!match[2]) { const input=await readJson(req);return json(res,200,business.setMember(actor,id,input)); }
        if(method==='DELETE'&&match[2]) return json(res,200,business.removeMember(actor,id,param(match[2]),await readJson(req)));
      }
      if((match=endpoint.match(/^\/api\/requirements\/([^/]+)\/task-batch$/)) && method==='POST') return json(res,201,business.createTaskBatch(actor,param(match[1]),await readJson(req)));
      if((match=endpoint.match(/^\/api\/requirements\/([^/]+)\/(submit-plan|return|reopen)$/)) && method==='POST') return json(res,200,business[{'submit-plan':'submitRequirementPlan',return:'returnRequirement',reopen:'reopenRequirement'}[match[2]]](actor,param(match[1]),await readJson(req)));
      if((match=endpoint.match(/^\/api\/projects\/([^/]+)\/schedule\/(preview|apply)$/)) && method==='POST') return json(res,200,business[match[2]==='preview'?'previewSchedule':'applySchedule'](actor,param(match[1]),await readJson(req)));
      if((match=endpoint.match(/^\/api\/attachments\/([^/]+)\/versions$/)) && method==='GET') return json(res,200,{versions:business.listAttachmentVersions(actor,param(match[1]))});
      if((match=endpoint.match(/^\/api\/tasks\/([^/]+)\/history$/)) && method==='GET') { const id=param(match[1]);business.getTask(actor,id);return json(res,200,{entries:business.listHistory(actor,{entityType:'task',entityId:id,limit:200})}); }
      if((match=endpoint.match(/^\/api\/requirements\/([^/]+)\/history$/)) && method==='GET') return json(res,200,{entries:business.listHistory(actor,{entityType:'requirement',entityId:param(match[1])})});
      if((match=endpoint.match(/^\/api\/requirements\/([^/]+)\/attachments$/))) {
        const id=param(match[1]);
        if(method==='GET') return json(res,200,{attachments:business.listAttachments(actor,id)});
        if(method==='POST') {
          const input=await readJson(req);
          if(typeof input.content!=='string'||!input.content.length||input.content.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(input.content)) throw fail(400,'INVALID_FILE','附件编码无效。');
          return json(res,201,business.uploadAttachment(actor,id,{name:input.name,mime:input.mime,contentBuffer:Buffer.from(input.content,'base64'),logicalId:input.logicalId,expectedVersion:input.expectedVersion}));
        }
      }
      if((match=endpoint.match(/^\/api\/projects\/([^/]+)\/documents$/))) {
        const id=param(match[1]);
        if(method==='GET') return json(res,200,{documents:business.listDocuments(actor,id)});
        if(method==='POST') {
          const input=await readJson(req);
          if(typeof input.content!=='string'||!input.content.length||input.content.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(input.content)) throw fail(400,'INVALID_FILE','文档编码无效。');
          const {content,...rest}=input;
          return json(res,201,business.uploadDocument(actor,id,{...rest,contentBuffer:Buffer.from(content,'base64')}));
        }
      }
      if((match=endpoint.match(/^\/api\/documents\/([^/]+)\/versions$/)) && method==='GET') return json(res,200,{versions:business.listDocumentVersions(actor,param(match[1]))});
      if((match=endpoint.match(/^\/api\/documents\/([^/]+)\/content$/)) && method==='GET') {
        const file=business.getDocumentContent(actor,param(match[1]),url.searchParams.has('version')?Number(url.searchParams.get('version')):undefined);
        res.writeHead(200,{'Content-Type':(file.mime||'text/plain')+'; charset=utf-8','Content-Disposition':"attachment; filename*=UTF-8''"+encodeURIComponent(file.name).replace(/['()*]/g,c=>'%'+c.charCodeAt(0).toString(16)),'Content-Security-Policy':"sandbox; default-src 'none'",'X-Document-Version':String(file.version)});
        return res.end(file.contentBuffer);
      }
      if((match=endpoint.match(/^\/api\/documents\/([^/]+)$/)) && method==='PATCH') return json(res,200,business.updateDocument(actor,param(match[1]),await readJson(req)));
      if((match=endpoint.match(/^\/api\/attachments\/([^/]+)$/)) && method==='GET') {
        const file=business.getAttachment(actor,param(match[1]),url.searchParams.has('version')?{version:Number(url.searchParams.get('version'))}:{});
        res.writeHead(200,{'Content-Type':file.mime||'application/octet-stream','Content-Disposition':"attachment; filename*=UTF-8''"+encodeURIComponent(file.name).replace(/['()*]/g,c=>'%'+c.charCodeAt(0).toString(16)),'Content-Security-Policy':"sandbox; default-src 'none'"});
        return res.end(file.contentBuffer);
      }
      const entities={projects:'Project',requirements:'Requirement',tasks:'Task'};
      if((match=endpoint.match(/^\/api\/(projects|requirements|tasks)(?:\/([^/]+))?$/))) {
        const kind=entities[match[1]],id=match[2]&&param(match[2]);
        if(method==='POST'&&!id) return json(res,201,business['create'+kind](actor,await readJson(req)));
        if(method==='GET'&&id) return json(res,200,business['get'+kind](actor,id));
        if(method==='PATCH'&&id) { const input=await readJson(req);return json(res,200,Object.hasOwn(input,'archived') ? business['archive'+kind](actor,id,input) : business['update'+kind](actor,id,input)); }
      }
      throw fail(404,'NOT_FOUND','接口不存在。');
    } catch(error) {
      const status=Number.isInteger(error.status) && error.status>=400&&error.status<600?error.status:500;
      if(status===500) logger.error(JSON.stringify({requestId,error:'INTERNAL_ERROR',type:error.name}));
      if(!res.headersSent) json(res,status,{error:status===500?'服务器处理失败，请联系管理员并提供请求编号。':error.message,code:status===500?'INTERNAL_ERROR':(error.code||'REQUEST_FAILED'),requestId,...(status!==500&&error.details?{details:error.details}:{})});
      else res.end();
    } finally {
      logger.info(JSON.stringify({requestId,method:req.method,path:endpoint,status:res.statusCode,durationMs:Date.now()-started}));
    }
  };
  const server=http.createServer(handler);
  server.requestTimeout=30_000;server.headersTimeout=15_000;server.keepAliveTimeout=5_000;
  return {server,handler,auth,business,proposals};
}

if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const production=process.env.NODE_ENV==='production';
  const publicOrigin=process.env.PUBLIC_ORIGIN || 'http://127.0.0.1:3000';
  if(production && (!process.env.PUBLIC_ORIGIN || new URL(publicOrigin).protocol!=='https:')) throw new Error('生产环境必须设置 PUBLIC_ORIGIN 为实际 HTTPS 站点地址。');
  const databasePath=process.env.DATABASE_PATH||path.join(HERE,'var','xinghe.sqlite');
  const db=openDatabase(databasePath);
  const backups=startBackupService({source:databasePath});
  const {server}=createApplication({db,backupService:backups,publicOrigin,secureCookies:production,trustProxy:process.env.TRUST_PROXY==='1',instanceId:process.env.XINGHE_LOCAL_RUN_ID||null,setupToken:process.env.XINGHE_SETUP_TOKEN||''});
  const port=Number(process.env.PORT||3001),host=process.env.HOST||'127.0.0.1';
  let dbClosed=false;
  const closeDb=()=>{if(!dbClosed){db.close();dbClosed=true;}};
  server.once('error',async error=>{
    const message=error.code==='EADDRINUSE'?'指定接口端口已被占用。':error.code==='EPERM'?'当前执行环境不允许监听本机端口。':'接口服务启动失败。';
    console.error(message);
    if(process.send)process.send({type:'api-error',code:error.code,message,instanceId:process.env.XINGHE_LOCAL_RUN_ID||null});
    await backups.stop();closeDb();process.exitCode=1;
  });
  server.listen(port,host,()=>{
    const actualPort=server.address().port;
    console.info(`接口服务已启动 ${host}:${actualPort}`);
    if(process.send)process.send({type:'api-ready',port:actualPort,instanceId:process.env.XINGHE_LOCAL_RUN_ID||null});
  });
  const shutdown=()=>server.close(async()=>{await backups.stop();closeDb();process.exit(0);});
  process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
}
