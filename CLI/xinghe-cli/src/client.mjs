import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash,randomUUID} from 'node:crypto';

export function fail(code,message,extra={}) { throw Object.assign(new Error(message),{code,...extra}); }
export function normalizeUrl(value) {
  let url;
  try { url=new URL(value); } catch { fail('INVALID_URL','请输入完整的平台地址。'); }
  if (url.username || url.password || url.search || url.hash || !['http:','https:'].includes(url.protocol)) fail('INVALID_URL','地址不可含账号、密码、查询参数或片段。');
  // TEMP: allow http for remote IP (user's own server)
  // if (url.protocol==='http:' && !['localhost','127.0.0.1','[::1]'].includes(url.hostname)) fail('HTTPS_REQUIRED','非本机地址必须使用 HTTPS（加密连接）。');
  url.pathname=url.pathname.replace(/\/+$/,'')+'/';
  return url.href.replace(/\/$/,'');
}
export class Store {
  constructor(dir=process.env.XINGHE_CONFIG_DIR || path.join(os.homedir(),'.config','xinghe')) { this.dir=path.resolve(dir); }
  async read(name,fallback=null) {
    const file=path.join(this.dir,name);
    try {
      const stat=await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink()) fail('UNSAFE_CONFIG','配置文件必须是普通文件。');
      return JSON.parse(await fs.readFile(file,'utf8'));
    } catch(error) { if(error.code==='ENOENT') return fallback; throw error; }
  }
  async write(name,value) {
    await fs.mkdir(this.dir,{recursive:true,mode:0o700});
    const stat=await fs.lstat(this.dir);
    if(!stat.isDirectory() || stat.isSymbolicLink()) fail('UNSAFE_CONFIG','配置目录不能是符号链接。');
    await fs.chmod(this.dir,0o700);
    const temp=path.join(this.dir,`.${randomUUID()}.tmp`);
    try { await fs.writeFile(temp,JSON.stringify(value)+'\n',{mode:0o600,flag:'wx'}); await fs.rename(temp,path.join(this.dir,name)); }
    finally { await fs.rm(temp,{force:true}); }
  }
  sessionName(profile,url) { return 'session-'+createHash('sha256').update(JSON.stringify([profile,url])).digest('hex')+'.json'; }
  async session(profile,url) { return this.read(this.sessionName(profile,url)); }
  async saveSession(profile,url,value) { await this.write(this.sessionName(profile,url),{...value,url}); }
  async clearSession(profile,url) { await fs.rm(path.join(this.dir,this.sessionName(profile,url)),{force:true}); }
}
export class Client {
  constructor({url,profile='default',store=new Store(),fetchImpl=fetch}) { Object.assign(this,{url:normalizeUrl(url),profile,store,fetchImpl}); }
  async request(endpoint,{method='GET',body,authenticated=true}={}) {
    const headers={Accept:'application/json','User-Agent':'xinghe-cli/0.3.0'};
    if(body!==undefined) headers['Content-Type']='application/json';
    if(authenticated) {
      const s=await this.store.session(this.profile,this.url);
      if(!s || s.url!==this.url || !Number.isFinite(Date.parse(s.expiresAt)) || Date.parse(s.expiresAt)<=Date.now()) fail('LOGIN_REQUIRED','此环境尚未登录或会话已过期，请执行 auth login（账号登录）。');
      if(!/^xinghe_session=[A-Za-z0-9_-]+$/.test(s.cookie) || !/^[a-f0-9]{64}$/.test(s.csrfToken)) fail('INVALID_SESSION','本地登录凭证无效，请重新登录。');
      headers.Cookie=s.cookie;
      if(method!=='GET') headers['X-CSRF-Token']=s.csrfToken;
    }
    let response;
    try {
      response=await this.fetchImpl(this.url+endpoint,{method,headers,body:body===undefined?undefined:JSON.stringify(body),redirect:'manual',signal:AbortSignal.timeout(20_000)});
    } catch { fail('NETWORK_ERROR',method==='GET'?'无法连接平台，请检查地址及服务状态。':'请求未获得明确结果，可能已经执行；请先查询平台核对，不要直接重试创建。'); }
    if(response.status>=300 && response.status<400) fail('REDIRECT_BLOCKED','平台返回重定向；请配置最终地址。凭证不会转发到其他地址。');
    let data;
    try { data=await response.json(); } catch { fail('INVALID_RESPONSE','平台未返回有效的结构化结果，请核对地址；写操作结果需在平台核对。'); }
    if(!response.ok) {
      if(response.status===401 && authenticated) await this.store.clearSession(this.profile,this.url);
      fail(data.code || 'HTTP_ERROR',data.error || '平台请求失败。',{status:response.status,requestId:data.requestId});
    }
    return {data,response};
  }
  // Document content is returned as a file, not JSON.
  async download(endpoint) {
    const s=await this.store.session(this.profile,this.url);
    if(!s || s.url!==this.url || !Number.isFinite(Date.parse(s.expiresAt)) || Date.parse(s.expiresAt)<=Date.now()) fail('LOGIN_REQUIRED','此环境尚未登录或会话已过期，请执行 auth login（账号登录）。');
    if(!/^xinghe_session=[A-Za-z0-9_-]+$/.test(s.cookie)) fail('INVALID_SESSION','本地登录凭证无效，请重新登录。');
    let response;
    try { response=await this.fetchImpl(this.url+endpoint,{method:'GET',headers:{Accept:'*/*','User-Agent':'xinghe-cli/0.3.0',Cookie:s.cookie},redirect:'manual',signal:AbortSignal.timeout(20_000)}); }
    catch { fail('NETWORK_ERROR','无法连接平台，请检查地址及服务状态。'); }
    if(response.status>=300 && response.status<400) fail('REDIRECT_BLOCKED','平台返回重定向；请配置最终地址。凭证不会转发到其他地址。');
    if(!response.ok) {
      let data={};try {data=await response.json();} catch {}
      if(response.status===401) await this.store.clearSession(this.profile,this.url);
      fail(data.code || 'HTTP_ERROR',data.error || '文档下载失败。',{status:response.status,requestId:data.requestId});
    }
    const disposition=response.headers.get('content-disposition') || '',encoded=disposition.match(/filename\*=UTF-8''([^;]+)/)?.[1];
    let name='';try {name=encoded?decodeURIComponent(encoded):'';} catch {}
    return {name,version:Number(response.headers.get('x-document-version')) || null,mime:(response.headers.get('content-type') || '').split(';')[0],content:Buffer.from(await response.arrayBuffer())};
  }
  async login(username,password) {
    const {data,response}=await this.request('/api/auth/login',{method:'POST',body:{username,password},authenticated:false});
    const cookie=response.headers.get('set-cookie')?.match(/(?:^|,\s*)(xinghe_session=[A-Za-z0-9_-]+)(?:;|$)/)?.[1];
    if(!cookie || !/^[a-f0-9]{64}$/.test(data.csrfToken) || !Number.isFinite(Date.parse(data.expiresAt))) fail('INVALID_SESSION','平台未返回有效登录凭证。');
    await this.store.saveSession(this.profile,this.url,{cookie,csrfToken:data.csrfToken,expiresAt:data.expiresAt});
    return {user:data.user,expiresAt:data.expiresAt};
  }
  async logout() {
    await this.request('/api/auth/logout',{method:'POST',body:{}});
    await this.store.clearSession(this.profile,this.url);
    return {loggedOut:true};
  }
}
