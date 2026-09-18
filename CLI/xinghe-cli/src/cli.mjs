import fs from 'node:fs/promises';
import {Client,Store,fail,normalizeUrl} from './client.mjs';

const HELP=`星河命令行工具 — 默认输出 JSON（结构化数据）

配置与账号：
  xinghe config set-url <平台地址> --profile local
  xinghe config show --profile local
  xinghe auth login --username admin --profile local
  xinghe auth me | logout
  xinghe health

查询与操作：
  xinghe project list
  xinghe project get <编号>
  xinghe project members <编号>
  xinghe requirement list --project <项目编号> [--query 关键词]
  xinghe requirement get <编号>
  xinghe requirement history <编号>
  xinghe requirement create --project <编号> --title <标题> [--data-file 文件]
  xinghe requirement update <编号> --version <版本号> --data-file 文件
  xinghe requirement schedule <编号> --version <版本号> --start YYYY-MM-DD --end YYYY-MM-DD
  xinghe task list --project <项目编号>
  xinghe task get <编号>
  xinghe task create --project <编号> --requirement <需求编号> --title <标题>
  xinghe task update <编号> --version <版本号> --data-file 文件
  xinghe task schedule <编号> --version <版本号> --start YYYY-MM-DD --end YYYY-MM-DD
  xinghe schedule list --project <编号> [--from YYYY-MM-DD --to YYYY-MM-DD]
  xinghe schema

全局参数：--profile 环境名（默认 default）；--url 地址（仅本次覆盖）
地址优先级：--url > XINGHE_URL（环境变量）> 当前环境配置。没有内置端口。
读取参数：--project、--owner、--status、--query、--include-archived
写入参数：--title、--description、--owner、--status、--priority、--hours、--points
写入文件：--data-file 文件或 -（标准输入）；--data JSON字符串；二者不能同时使用。
--dry-run 仅输出请求预览，不发送请求、不代表后端校验通过。
登录默认终端隐藏输入；自动化可用 --password-stdin 从安全输入通道读取。
修改必须使用刚查询的 version（版本号），冲突不会自动覆盖。创建不会自动重试。
schema（字段说明）列出高级字段；--help 查看帮助。`;
const SCHEMA={
  requirement:{create:['projectId','title','description','acceptance','source','priority','ownerId','assigneeId','collaboratorIds','planStart','planEnd','estimatePoints'],update:['version','title','description','acceptance','source','status','priority','ownerId','assigneeId','collaboratorIds','planStart','planEnd','estimatePoints','reason','force'],notes:'新建需求状态为未确定；已排期等状态必须遵守平台流转规则。force 仅需求超项目目标日期确认使用。'},
  task:{create:['projectId','requirementId','title','description','ownerId','startDate','dueDate','estimateHours','estimatePoints'],update:['version','requirementId','title','description','ownerId','status','startDate','dueDate','estimateHours','estimatePoints','reason'],notes:'新建任务状态为待开始；日期采用 YYYY-MM-DD（年-月-日）。'},
  notes:'数组、数字、布尔值请用结构化数据文件；成员编号通过 project members 查询。最终校验由后端负责。无批量原子提交、自动排程或自动重试。'
};
const FLAGS=new Set(['help','include-archived','dry-run','password-stdin']);
const VALUES=new Set(['profile','url','username','project','owner','status','query','from','to','title','description','priority','requirement','hours','points','version','start','end','data-file','data']);
export function parse(args) {
  const opts=Object.create(null),pos=[];
  for(let i=0;i<args.length;i++) {
    const a=args[i];
    if(a==='-h') {opts.help=true;continue;}
    if(!a.startsWith('--')) {pos.push(a);continue;}
    const key=a.slice(2);
    if(Object.hasOwn(opts,key)) fail('USAGE',`参数重复：${a}`);
    if(FLAGS.has(key)) opts[key]=true;
    else if(VALUES.has(key)) { if(i+1>=args.length || args[i+1].startsWith('--')) fail('USAGE',`参数缺少值：${a}`); opts[key]=args[++i]; }
    else fail('USAGE',`未知参数：${a}`);
  }
  return {opts,pos};
}
function allowed(opts,names) {
  const keys=new Set(['profile','url','help',...names]);
  for(const key of Object.keys(opts)) if(!keys.has(key)) fail('USAGE',`此命令不支持参数：--${key}`);
}
function identifier(value) { if(!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(value||'')) fail('USAGE','请提供有效记录编号。'); return value; }
function date(value) {
  if(!/^\d{4}-\d{2}-\d{2}$/.test(value || '') || value<'0001-01-01') fail('USAGE','日期应为 YYYY-MM-DD（年-月-日）。');
  const stamp=Date.parse(value+'T00:00:00Z');
  if(!Number.isFinite(stamp) || new Date(stamp).toISOString().slice(0,10)!==value) fail('USAGE','日期无效。');
  return value;
}
async function readInput(stream=process.stdin) {
  let text='';
  for await(const part of stream) {text+=part.toString();if(Buffer.byteLength(text)>3*1024*1024) fail('INPUT_TOO_LARGE','输入超过 3 兆字节。');}
  return text;
}
export async function readPassword(fromStdin) {
  if(fromStdin) return (await readInput()).replace(/\r?\n$/,'');
  if(!process.stdin.isTTY) fail('PASSWORD_INPUT','请在终端交互登录，或使用 --password-stdin 安全传入密码。');
  process.stderr.write('平台密码（输入不显示）：');
  return new Promise((resolve,reject)=>{
    const input=process.stdin,wasRaw=input.isRaw;let value='';
    input.setRawMode(true);input.resume();input.setEncoding('utf8');
    const done=(error)=>{input.off('data',onData);input.setRawMode(Boolean(wasRaw));input.pause();process.stderr.write('\n');error?reject(error):resolve(value);};
    function onData(chunk) {
      for(const char of chunk) {
        if(char==='\u0003' || char==='\u0004') {done(Object.assign(new Error('已取消登录。'),{code:'CANCELLED'}));return;}
        if(char==='\r' || char==='\n') {done();return;}
        if(char==='\u007f' || char==='\b') value=Array.from(value).slice(0,-1).join('');
        else if(char>=' ' && char!=='\u007f') value+=char;
      }
    }
    input.on('data',onData);
  });
}
async function payload(opts) {
  if(opts.data!==undefined && opts['data-file']!==undefined) fail('USAGE','--data 与 --data-file 只能选一个。');
  let value={};
  if(opts.data!==undefined || opts['data-file']!==undefined) {
    const source=opts.data ?? (opts['data-file']==='-'?await readInput():await fs.readFile(opts['data-file'],'utf8'));
    if(Buffer.byteLength(source)>3*1024*1024) fail('INPUT_TOO_LARGE','输入超过 3 兆字节。');
    try {value=JSON.parse(source);} catch {fail('INVALID_JSON','输入文件不是有效的结构化数据。');}
    if(!value || typeof value!=='object' || Array.isArray(value)) fail('INVALID_JSON','输入内容必须是对象。');
  }
  const map={project:'projectId',requirement:'requirementId',owner:'ownerId',title:'title',description:'description',status:'status',priority:'priority',hours:'estimateHours',points:'estimatePoints',version:'version'};
  for(const [flag,key] of Object.entries(map)) if(opts[flag]!==undefined) {
    if(Object.hasOwn(value,key)) fail('USAGE',`文件与参数重复指定字段：${key}`);
    value[key]=['hours','points','version'].includes(flag)?Number(opts[flag]):opts[flag];
    if(['hours','points','version'].includes(flag) && (!opts[flag].trim() || !Number.isFinite(value[key]) || value[key]<0)) fail('USAGE',`--${flag} 必须是有效非负数字。`);
  }
  return value;
}
export async function run(args,{store=new Store(),fetchImpl=fetch,passwordReader=readPassword,env=process.env}={}) {
  const {opts,pos}=parse(args);
  if(opts.help || !pos.length) return HELP;
  const [group,action,id]=pos;
  if(group==='schema' && pos.length===1) {allowed(opts,[]);return {data:SCHEMA};}
  const profile=opts.profile || 'default';
  if(!/^[a-zA-Z0-9_-]{1,40}$/.test(profile)) fail('USAGE','环境名称限 1 至 40 位字母、数字、下划线或连字符。');
  const configName=`profile-${profile}.json`;
  const config=await store.read(configName,{});
  if(group==='config') {
    allowed(opts,[]);
    if(action==='set-url' && pos.length===3) {
      if(opts.url) fail('USAGE','set-url 命令请直接提供地址，不使用 --url。');
      const url=normalizeUrl(id);await store.write(configName,{url});return {data:{profile,url,note:'地址已保存；新地址需要独立登录。'}};
    }
    if(action==='show' && pos.length===2) {
      const selected=opts.url || env.XINGHE_URL || config.url;
      return {data:{profile,url:selected?normalizeUrl(selected):null,configuredUrl:config.url || null}};
    }
    fail('USAGE','配置命令格式错误，使用 --help 查看。');
  }
  const selected=opts.url || env.XINGHE_URL || config.url;
  if(!selected) fail('URL_REQUIRED','请先 config set-url 配置平台地址，或提供 --url。');
  const client=new Client({url:selected,profile,store,fetchImpl});
  const result=data=>({server:client.url,profile,data});
  if(group==='health' && pos.length===1) {allowed(opts,[]);return result((await client.request('/api/health',{authenticated:false})).data);}
  if(group==='auth' && pos.length===2) {
    if(action==='login') {
      allowed(opts,['username','password-stdin']);
      if(!opts.username) fail('USAGE','请提供 --username 用户名。');
      return result(await client.login(opts.username,await passwordReader(Boolean(opts['password-stdin']))));
    }
    allowed(opts,[]);
    if(action==='me') {const {data}=await client.request('/api/auth/me');return result({user:data.user,expiresAt:data.expiresAt});}
    if(action==='logout') return result(await client.logout());
    fail('USAGE','未知账号命令。');
  }
  const plural={project:'projects',requirement:'requirements',task:'tasks'}[group];
  if((plural || group==='schedule') && action==='list' && pos.length===2) {
    allowed(opts,['project','owner','status','query','include-archived',...(group==='schedule'?['from','to']:[])]);
    if(opts.project) identifier(opts.project);
    if(opts.from) date(opts.from);if(opts.to) date(opts.to);
    if(opts.from && opts.to && opts.from>opts.to) fail('USAGE','开始日期不能晚于结束日期。');
    const {data}=await client.request('/api/bootstrap'+(opts['include-archived']?'?includeArchived=1':''));
    let items=data[plural || 'tasks'];
    if(opts.project) items=items.filter(x=>group==='project'?x.id===opts.project:x.projectId===opts.project);
    if(opts.owner) items=items.filter(x=>x.ownerId===opts.owner);
    if(opts.status) items=items.filter(x=>x.status===opts.status);
    if(opts.query) {const q=opts.query.toLocaleLowerCase();items=items.filter(x=>[x.id,x.title,x.name,x.description].some(s=>String(s || '').toLocaleLowerCase().includes(q)));}
    if(group==='schedule') {
      const unscheduled=items.filter(x=>!x.startDate || !x.dueDate || x.startDate>x.dueDate);
      items=items.filter(x=>x.startDate && x.dueDate && x.startDate<=x.dueDate && (!opts.from || x.dueDate>=opts.from) && (!opts.to || x.startDate<=opts.to)).sort((a,b)=>a.startDate.localeCompare(b.startDate));
      return result({items,count:items.length,unscheduled,note:'未完整排期的任务单独列出；此列表不计算人员负荷或任务依赖。'});
    }
    return result({items,count:items.length});
  }
  if(plural && pos.length===3 && ['get','members','history'].includes(action)) {
    allowed(opts,[]);identifier(id);
    if(action==='members' && group!=='project' || action==='history' && group!=='requirement') fail('USAGE','此对象不支持该命令。');
    return result((await client.request(`/api/${plural}/${id}`+(action==='get'?'':`/${action}`))).data);
  }
  if(['requirement','task'].includes(group) && ['create','update','schedule'].includes(action) && pos.length===(action==='create'?2:3)) {
    allowed(opts,['project','requirement','title','description','owner','status','priority','hours','points','version','data','data-file','dry-run',...(action==='schedule'?['start','end']:[])]);
    const body=await payload(opts);
    if(action!=='create') {identifier(id);if(!Number.isSafeInteger(body.version) || body.version<1) fail('VERSION_REQUIRED','修改必须提供查询结果中的 version（版本号）。');}
    else {identifier(body.projectId);if(typeof body.title!=='string' || !body.title.trim()) fail('USAGE','创建必须提供标题。');}
    if(action==='schedule') {
      const start=date(opts.start),end=date(opts.end);
      if(start>end) fail('USAGE','开始日期不能晚于结束日期。');
      const keys=group==='task'?['startDate','dueDate']:['planStart','planEnd'];
      if(keys.some(k=>Object.hasOwn(body,k))) fail('USAGE','排期日期不能在参数和数据文件中重复指定。');
      body[keys[0]]=start;body[keys[1]]=end;
    }
    const fields=SCHEMA[group][action==='create'?'create':'update'];
    for(const key of Object.keys(body)) if(!fields.includes(key)) fail('USAGE',`此操作不支持字段：${key}`);
    const endpoint=`/api/${plural}`+(action==='create'?'':`/${id}`),method=action==='create'?'POST':'PATCH';
    if(opts['dry-run']) return result({previewOnly:true,serverValidated:false,method,endpoint,body});
    return result((await client.request(endpoint,{method,body})).data);
  }
  fail('USAGE','未知命令或参数数量错误，使用 --help 查看。');
}
