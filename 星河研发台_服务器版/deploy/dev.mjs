import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export function validateLocalPorts(env=process.env) {
  const parse=value=>value===undefined||value===''?0:/^\d+$/.test(String(value))?Number(value):NaN;
  const web=parse(env.WEB_PORT),api=parse(env.API_PORT);
  if(![web,api].every(port=>Number.isInteger(port)&&port>=0&&port<=65535))throw new Error('网页与接口端口必须是 0 至 65535 的整数；0 表示自动分配。');
  return {web,api};
}

// Only a genuinely occupied explicit port may fall back to an OS-assigned port.
export function listenWithFallback(server,port,host='127.0.0.1') {
  return new Promise((resolve,reject)=>{
    function attempt(requested) {
      const cleanup=()=>{server.removeListener('error',failed);server.removeListener('listening',ready);};
      const failed=error=>{cleanup();if(error.code==='EADDRINUSE'&&requested>0)attempt(0);else reject(error);};
      const ready=()=>{cleanup();const actual=server.address()?.port;if(!Number.isInteger(actual)||actual<1)reject(new Error('未获得有效网页端口。'));else resolve(actual);};
      server.once('error',failed);server.once('listening',ready);
      try{server.listen(requested,host);}catch(error){failed(error);}
    }
    attempt(port);
  });
}

export function stopChild(child,timeoutMs=2000) {
  if(!child||child.exitCode!==null&&child.exitCode!==undefined||child.signalCode)return Promise.resolve();
  return new Promise(resolve=>{
    let timer;
    const done=()=>{clearTimeout(timer);child.removeListener('exit',done);resolve();};
    child.once('exit',done);
    timer=setTimeout(()=>{try{child.kill('SIGKILL');}catch{}done();},timeoutMs);
    try{child.kill('SIGTERM');}catch{done();}
  });
}

export function waitForMessage(child,{type,instanceId,timeoutMs=20000,signal}) {
  return new Promise((resolve,reject)=>{
    let timer;
    const cleanup=()=>{clearTimeout(timer);child.removeListener('message',message);child.removeListener('error',failed);child.removeListener('exit',exited);signal?.removeEventListener('abort',aborted);};
    const failed=error=>{cleanup();reject(error);};
    const exited=()=>failed(new Error('服务在就绪前退出。'));
    const aborted=()=>failed(Object.assign(new Error('启动已取消。'),{code:'ABORT_ERR'}));
    const message=value=>{
      if(!value||value.instanceId!==instanceId)return;
      if(value.type==='api-error'||value.type==='error')return failed(Object.assign(new Error('服务进程启动失败。'),{code:value.code}));
      if(value.type===type){cleanup();resolve(value);}
    };
    child.on('message',message);child.once('error',failed);child.once('exit',exited);
    timer=setTimeout(()=>failed(Object.assign(new Error('服务未在规定时间内就绪。'),{code:'STARTUP_TIMEOUT'})),timeoutMs);
    signal?.addEventListener('abort',aborted,{once:true});
    if(signal?.aborted)aborted();
  });
}

function frontendHandler(apiPort) {
  const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml'};
  const frontend=path.join(root,'frontend');
  return (req,res)=>{
    if(req.url.startsWith('/api/')) {
      if(!apiPort()){res.writeHead(503,{'Content-Type':'application/json'});return res.end(JSON.stringify({error:'接口服务暂未就绪。'}));}
      const proxy=http.request({hostname:'127.0.0.1',port:apiPort(),path:req.url,method:req.method,headers:req.headers},upstream=>{res.writeHead(upstream.statusCode,upstream.headers);upstream.pipe(res);});
      proxy.on('error',()=>{if(!res.headersSent)res.writeHead(502,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'接口服务暂未就绪。'}));});
      req.pipe(proxy);return;
    }
    if(!['GET','HEAD'].includes(req.method)){res.writeHead(405);return res.end();}
    let url;try{url=decodeURIComponent(new URL(req.url,'http://localhost').pathname);}catch{res.writeHead(400);return res.end();}
    const requested=path.resolve(frontend,'.'+url);
    if(!requested.startsWith(frontend+path.sep)&&requested!==frontend){res.writeHead(403);return res.end();}
    let file=requested;
    if(!fs.existsSync(file)||!fs.statSync(file).isFile())file=path.join(frontend,'index.html');
    if(!fs.existsSync(file)){res.writeHead(503);return res.end('前端尚未就绪。');}
    res.writeHead(200,{'Content-Type':mime[path.extname(file)]||'application/octet-stream','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"});
    if(req.method==='HEAD')return res.end();const stream=fs.createReadStream(file);stream.on('error',()=>res.destroy());stream.pipe(res);
  };
}

export async function startDev({env=process.env,spawnProcess=spawn,createServer=http.createServer,send=value=>{if(process.connected)process.send(value);},timeoutMs=20000,signal}={}) {
  const ports=validateLocalPorts(env),instanceId=env.XINGHE_LOCAL_RUN_ID||randomUUID();
  env={...env,XINGHE_LOCAL_RUN_ID:instanceId};
  let child,apiPort,closing=false,resolveClosed,listenTask=Promise.resolve();
  const closed=new Promise(resolve=>{resolveClosed=resolve;});
  const server=createServer(frontendHandler(()=>apiPort));
  const stop=async(code=0)=>{
    if(closing)return closed;
    closing=true;signal?.removeEventListener('abort',aborted);
    const webClosed=listenTask.catch(()=>{}).then(()=>new Promise(resolve=>{
      if(!server.listening)return resolve();
      const timer=setTimeout(()=>{server.closeAllConnections?.();resolve();},2000);
      server.close(()=>{clearTimeout(timer);resolve();});
    }));
    await Promise.all([webClosed,stopChild(child)]);resolveClosed(code);return code;
  };
  const aborted=()=>{void stop(0);};
  signal?.addEventListener('abort',aborted,{once:true});
  try {
    if(signal?.aborted)throw Object.assign(new Error('启动已取消。'),{code:'ABORT_ERR'});
    listenTask=listenWithFallback(server,ports.web);
    const webPort=await listenTask;
    if(closing){await stop();throw Object.assign(new Error('启动已取消。'),{code:'ABORT_ERR'});}
    const url=`http://127.0.0.1:${webPort}`;
    server.on('error',error=>{send({type:'error',code:error.code,instanceId});void stop(1);});
    for(let attempt=0;attempt<2;attempt++) {
      child=spawnProcess(process.execPath,['backend/server.mjs'],{cwd:root,stdio:['inherit','inherit','inherit','ipc'],env:{...env,NODE_ENV:'development',PORT:String(attempt===0?ports.api:0),HOST:'127.0.0.1',PUBLIC_ORIGIN:url}});
      try {
        const ready=await waitForMessage(child,{type:'api-ready',instanceId,timeoutMs,signal});
        if(child.exitCode!==null&&child.exitCode!==undefined||child.signalCode)throw new Error('接口在就绪后立即退出。');
        apiPort=ready.port;
        if(!Number.isInteger(apiPort)||apiPort<1||apiPort>65535||apiPort===webPort)throw new Error('接口返回了无效端口。');
        break;
      } catch(error) {
        await stopChild(child);
        if(error.code==='EADDRINUSE'&&ports.api>0&&attempt===0&&!signal?.aborted)continue;
        throw error;
      }
    }
    child.once('exit',()=>{if(!closing)void stop(1);});
    child.on('error',()=>{if(!closing)void stop(1);});
    if(signal?.aborted)throw Object.assign(new Error('启动已取消。'),{code:'ABORT_ERR'});
    send({type:'ready',url,apiPort,instanceId});
    return {url,apiPort,instanceId,child,stop,closed};
  } catch(error) {await stop(1);throw error;}
}

async function main() {
  const controller=new AbortController();
  const abort=()=>controller.abort();
  process.once('SIGINT',abort);process.once('SIGTERM',abort);process.once('disconnect',abort);
  try{const running=await startDev({signal:controller.signal});process.exitCode=await running.closed;}
  catch(error){if(process.connected)process.send({type:'error',code:error.code,instanceId:process.env.XINGHE_LOCAL_RUN_ID||''});console.error(error.code==='EPERM'?'当前执行环境不允许监听本机端口，服务未启动。':'网页或接口服务启动失败。');process.exitCode=error.code==='ABORT_ERR'?0:1;}
  finally{process.removeListener('SIGINT',abort);process.removeListener('SIGTERM',abort);process.removeListener('disconnect',abort);if(process.connected)process.disconnect();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))void main();
