import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {Client,Store,fail,normalizeUrl} from './client.mjs';
import {schedulePlan,validatePlan} from './plan.mjs';

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
  xinghe requirement list --project <项目编号> [--assignee 主责开发编号] [--query 关键词]
  xinghe requirement get <编号>
  xinghe requirement history <编号>
  xinghe requirement create --project <编号> --title <标题> [--data-file 文件]
  xinghe requirement import --project <编号> --data-file 需求数组.json [--dry-run]   （批量导入，按标题去重，可安全重跑）
  xinghe requirement update <编号> --version <版本号> --data-file 文件
  xinghe requirement schedule <编号> --version <版本号> --start YYYY-MM-DD --end YYYY-MM-DD
  xinghe requirement archive|restore <编号> --version <版本号>
  xinghe task list --project <项目编号>
  xinghe task get <编号>
  xinghe task create --project <编号> --requirement <需求编号> --title <标题>
  xinghe task update <编号> --version <版本号> --data-file 文件
  xinghe task schedule <编号> --version <版本号> --start YYYY-MM-DD --end YYYY-MM-DD
  xinghe task batch --requirement <需求编号> --version <需求版本号> --data-file 任务数组.json [--request-id 提交编号]
  xinghe task archive|restore <编号> --version <版本号>
  xinghe schedule list [--project <编号>] [--kind task|requirement] [--from YYYY-MM-DD --to YYYY-MM-DD]
  xinghe schedule preview --project <编号> --data-file 改期.json
  xinghe schedule apply --project <编号> --data-file 改期.json --token <预览令牌> --reason <原因> [--force]
  xinghe document list --project <编号>
  xinghe document versions <文档编号>
  xinghe document download <文档编号> [--doc-version 版本] [--output 文件]
  xinghe document upload --project <编号> --file 路径 [--type PRD|原型|技术方案|验收用例|其他] [--title 标题] [--note 说明] [--primary]
  xinghe document upload --project <编号> --document <文档编号> --file 路径 [--note 说明]   （上传新版本）
  xinghe work [--date YYYY-MM-DD]   （我的工作与站内提醒）
  xinghe plan preview --project <编号> --data-file 计划.json   （按日历与产能自动排期，不写入）
  xinghe plan apply --project <编号> --data-file 计划.json [--force]   （批量建任务并给需求排期）
  xinghe schema

全局参数：--profile 环境名（默认 default）；--url 地址（仅本次覆盖）
地址优先级：--url > XINGHE_URL（环境变量）> 当前环境配置。没有内置端口。
读取参数：--project、--owner、--status、--query、--include-archived
写入参数：--title、--description、--owner、--status、--priority、--hours、--points
写入文件：--data-file 文件或 -（标准输入）；--data JSON字符串；二者不能同时使用。
--dry-run 仅输出请求预览，不发送请求、不代表后端校验通过。
登录默认终端隐藏输入；自动化可用 --password-stdin 从安全输入通道读取。
修改必须使用刚查询的 version（版本号），冲突不会自动覆盖。创建不会自动重试；task batch 可用同一 --request-id 安全重试。
schema（字段说明）列出高级字段；--help 查看帮助。`;
const SCHEMA={
  requirement:{create:['projectId','title','description','acceptance','source','priority','ownerId','assigneeId','collaboratorIds','planStart','planEnd','estimatePoints','dependencyIds','docRefs','acceptanceCases'],update:['version','title','description','acceptance','source','status','priority','ownerId','assigneeId','collaboratorIds','planStart','planEnd','estimatePoints','dependencyIds','docRefs','acceptanceCases','reason','force'],
    docRefs:'[{"document":"文档文件名","type":"PRD|原型|技术方案|验收用例|其他","sections":["章节编号"]}]；PRD 章节编号取标题里的〔编号〕，技术方案取 §n.n，验收用例取每个 Scenario 的第一个 @标签。acceptanceCases 为验收用例编号列表。只有产品经理和管理员能修改。',
    statuses:['未确定','待评审','已确定','待排期','已排期','开发中','测试中','已完成','已终止'],
    notes:'需求由产品经理创建，从「未确定」开始：未确定 → 待评审 → 已确定 →（主开发拆分任务、指定主责开发）→ 已排期 → 开发中 → 测试中 → 已完成。assigneeId（主责开发）由主开发指定；dependencyIds 为同项目的前置需求，未完成时不能开工。force 仅在计划超出项目目标日期时确认使用。docRefs（关联文档章节）只读。'},
  task:{create:['projectId','requirementId','title','description','ownerId','startDate','dueDate','estimateHours','estimatePoints','dependencyIds'],update:['version','requirementId','title','description','ownerId','status','startDate','dueDate','estimateHours','estimatePoints','dependencyIds','reason'],
    statuses:['wait（待开始）','develop（开发中）','test（测试中）','done（已完成）','terminated（已终止）'],
    notes:'任务必须关联需求。主开发可给任何成员派任务；开发只能给自己建任务。新任务从待开始创建；不能验收自己负责的任务（主开发的纯技术任务除外）。日期采用 YYYY-MM-DD。'},
  taskBatch:{file:'任务对象数组，或 {"tasks":[…]}；每项字段同 task.create（projectId、requirementId 可省略），1 至 100 条，整包校验、要么全部创建要么不创建。',requestId:'同一 --request-id 重复提交返回首次结果，不会重复创建。'},
  scheduleChanges:{file:'改期数组，或 {"changes":[…]}；每项 {requirementId, version, planStart, planEnd}，1 至 100 条。',flow:'先 schedule preview 取得 previewToken，再用同一文件 schedule apply；超出项目目标日期需加 --force。'},
  requirementImport:{file:'需求对象数组，或 {"requirements":[…]}；字段同 requirement.create（projectId 可省略），可加 key 作为本地标识。',behavior:'按标题去重：同项目已有同名未归档需求时跳过并返回其编号，因此可以安全重跑。新需求一律从「未确定」开始。会检查 docRefs 引用的文档与章节是否存在于已上传文档。'},
  plan:{file:'{startDate, capacityHours, capacityOverrides?, holidays?, extraWorkdays?, acceptanceBufferDays?(默认 1), phases?, phaseDeadlines?, owners?, respectExistingLoad?(默认 true), tasks:[{requirement:需求编号, owner:用户名|成员编号|owners 别名, phase?, hours, title, desc?, after?:[前置任务标题]}]}',
    behavior:'按阶段顺序与文件顺序把任务依次放进负责人的工作日历；默认接在负责人已有未完成任务之后。需求计划日期 = 任务最早开始 ～ 最晚结束 + 验收缓冲；主责开发 = 工时最多的人。apply 需要主开发或管理员账号；已有其他任务的需求跳过；同一计划重跑不会重复创建。计划结束晚于项目目标日期时必须加 --force。'},
  notes:'数组、数字、布尔值请用结构化数据文件；成员编号通过 project members 查询。最终校验由后端负责。'
};
const FLAGS=new Set(['help','include-archived','dry-run','password-stdin','force','primary']);
const VALUES=new Set(['profile','url','username','project','owner','assignee','status','query','from','to','title','description','priority','requirement','hours','points','version','start','end','data-file','data','request-id','token','reason','kind','doc-version','output','file','type','note','document','date']);
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
async function listPayload(opts,key) {
  if(opts.data===undefined && opts['data-file']===undefined) fail('USAGE','请用 --data-file 或 --data 提供数据。');
  if(opts.data!==undefined && opts['data-file']!==undefined) fail('USAGE','--data 与 --data-file 只能选一个。');
  const source=opts.data ?? (opts['data-file']==='-'?await readInput():await fs.readFile(opts['data-file'],'utf8'));
  if(Buffer.byteLength(source)>3*1024*1024) fail('INPUT_TOO_LARGE','输入超过 3 兆字节。');
  let value;try {value=JSON.parse(source);} catch {fail('INVALID_JSON','输入文件不是有效的结构化数据。');}
  const list=Array.isArray(value)?value:value?.[key];
  if(!Array.isArray(list) || !list.length || list.length>100 || list.some(item=>!item || typeof item!=='object' || Array.isArray(item))) fail('INVALID_JSON',`需要 1 至 100 个对象的数组（或 {"${key}":[…]}）。`);
  return list;
}
async function objectPayload(opts) {
  if(opts.data===undefined && opts['data-file']===undefined) fail('USAGE','请用 --data-file 或 --data 提供数据。');
  if(opts.data!==undefined && opts['data-file']!==undefined) fail('USAGE','--data 与 --data-file 只能选一个。');
  const source=opts.data ?? (opts['data-file']==='-'?await readInput():await fs.readFile(opts['data-file'],'utf8'));
  if(Buffer.byteLength(source)>3*1024*1024) fail('INPUT_TOO_LARGE','输入超过 3 兆字节。');
  try {const value=JSON.parse(source);if(value && typeof value==='object' && !Array.isArray(value)) return value;} catch {}
  fail('INVALID_JSON','输入内容必须是结构化数据对象。');
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
    allowed(opts,['project','owner','status','query','include-archived',...(group==='requirement'?['assignee']:[]),...(group==='schedule'?['from','to','kind']:[])]);
    if(opts.kind && !['task','requirement'].includes(opts.kind)) fail('USAGE','--kind 只能是 task 或 requirement。');
    if(opts.project) identifier(opts.project);
    if(opts.from) date(opts.from);if(opts.to) date(opts.to);
    if(opts.from && opts.to && opts.from>opts.to) fail('USAGE','开始日期不能晚于结束日期。');
    const {data}=await client.request('/api/bootstrap'+(opts['include-archived']?'?includeArchived=1':''));
    const kind=group==='schedule'?(opts.kind || 'task'):null;
    let items=data[plural || (kind==='requirement'?'requirements':'tasks')];
    if(kind==='requirement') items=items.map(x=>({...x,startDate:x.planStart,dueDate:x.planEnd}));
    if(opts.project) items=items.filter(x=>group==='project'?x.id===opts.project:x.projectId===opts.project);
    if(opts.owner) items=items.filter(x=>x.ownerId===opts.owner);
    if(opts.assignee) items=items.filter(x=>x.assigneeId===opts.assignee);
    if(opts.status) items=items.filter(x=>x.status===opts.status);
    if(opts.query) {const q=opts.query.toLocaleLowerCase();items=items.filter(x=>[x.id,x.title,x.name,x.description].some(s=>String(s || '').toLocaleLowerCase().includes(q)));}
    if(group==='schedule') {
      const unscheduled=items.filter(x=>!x.startDate || !x.dueDate || x.startDate>x.dueDate);
      items=items.filter(x=>x.startDate && x.dueDate && x.startDate<=x.dueDate && (!opts.from || x.dueDate>=opts.from) && (!opts.to || x.startDate<=opts.to)).sort((a,b)=>a.startDate.localeCompare(b.startDate));
      return result({kind,items,count:items.length,unscheduled,note:kind==='requirement'?'需求按计划开始 / 结束日期（planStart / planEnd）筛选；未排期需求单独列出。':'未完整排期的任务单独列出；此列表不计算人员负荷或任务依赖。'});
    }
    return result({items,count:items.length});
  }
  if(plural && pos.length===3 && ['get','members','history'].includes(action)) {
    allowed(opts,[]);identifier(id);
    if(action==='members' && group!=='project' || action==='history' && group!=='requirement') fail('USAGE','此对象不支持该命令。');
    return result((await client.request(`/api/${plural}/${id}`+(action==='get'?'':`/${action}`))).data);
  }
  if(['requirement','task'].includes(group) && ['archive','restore'].includes(action) && pos.length===3) {
    allowed(opts,['version','dry-run']);identifier(id);
    const version=Number(opts.version);if(!Number.isSafeInteger(version) || version<1) fail('VERSION_REQUIRED','归档或恢复必须提供查询结果中的 version（版本号）。');
    const endpoint=`/api/${plural}/${id}`,body={version,archived:action==='archive'};
    if(opts['dry-run']) return result({previewOnly:true,serverValidated:false,method:'PATCH',endpoint,body});
    return result((await client.request(endpoint,{method:'PATCH',body})).data);
  }
  if(group==='task' && action==='batch' && pos.length===2) {
    allowed(opts,['requirement','version','data','data-file','request-id','dry-run']);
    const requirementId=identifier(opts.requirement),version=Number(opts.version);
    if(!Number.isSafeInteger(version) || version<1) fail('VERSION_REQUIRED','批量拆分必须提供需求当前的 version（版本号）。');
    const tasks=await listPayload(opts,'tasks');
    const requestId=opts['request-id'] ?? `cli-${randomUUID()}`;identifier(requestId);
    for(const item of tasks) for(const key of Object.keys(item)) if(!SCHEMA.task.create.includes(key)) fail('USAGE',`任务不支持字段：${key}`);
    const endpoint=`/api/requirements/${requirementId}/task-batch`,body={version,requestId,tasks};
    if(opts['dry-run']) return result({previewOnly:true,serverValidated:false,method:'POST',endpoint,body});
    try {return result({requestId,...(await client.request(endpoint,{method:'POST',body})).data});}
    catch(error) {if(error.code==='NETWORK_ERROR') error.message+=`可用同一提交编号安全重试：--request-id ${requestId}`;throw error;}
  }
  if(group==='schedule' && ['preview','apply'].includes(action) && pos.length===2) {
    allowed(opts,['project','data','data-file','dry-run',...(action==='apply'?['token','reason','force']:[])]);
    const projectId=identifier(opts.project),changes=await listPayload(opts,'changes');
    for(const item of changes) { for(const key of Object.keys(item)) if(!['requirementId','version','planStart','planEnd'].includes(key)) fail('USAGE',`改期不支持字段：${key}`); if(item.planStart) date(item.planStart); if(item.planEnd) date(item.planEnd); }
    const body={changes};
    if(action==='apply') {
      if(!/^[a-f0-9]{64}$/.test(opts.token || '')) fail('USAGE','请提供 schedule preview 返回的 previewToken（--token）。');
      if(!opts.reason?.trim()) fail('USAGE','批量改期必须填写 --reason 原因。');
      Object.assign(body,{previewToken:opts.token,reason:opts.reason},opts.force?{force:true}:{});
    }
    const endpoint=`/api/projects/${projectId}/schedule/${action}`;
    if(opts['dry-run']) return result({previewOnly:true,serverValidated:false,method:'POST',endpoint,body});
    return result((await client.request(endpoint,{method:'POST',body})).data);
  }
  if(group==='document') {
    if(action==='list' && pos.length===2) {allowed(opts,['project']);return result((await client.request(`/api/projects/${identifier(opts.project)}/documents`)).data);}
    if(action==='versions' && pos.length===3) {allowed(opts,[]);return result((await client.request(`/api/documents/${identifier(id)}/versions`)).data);}
    if(action==='download' && pos.length===3) {
      allowed(opts,['doc-version','output']);identifier(id);
      if(opts['doc-version']!==undefined && !/^[1-9]\d{0,5}$/.test(opts['doc-version'])) fail('USAGE','--doc-version 应为正整数。');
      const file=await client.download(`/api/documents/${id}/content`+(opts['doc-version']?`?version=${opts['doc-version']}`:''));
      const meta={documentId:id,name:file.name,version:file.version,mime:file.mime,bytes:file.content.length};
      if(!opts.output) return result({...meta,content:file.content.toString('utf8')});
      await fs.writeFile(opts.output,file.content,{flag:'wx'}).catch(error=>{if(error.code==='EEXIST')fail('OUTPUT_EXISTS','输出文件已存在，不会覆盖。');throw error;});
      return result({...meta,output:path.resolve(opts.output)});
    }
    if(action==='upload' && pos.length===2) {
      allowed(opts,['project','file','type','title','note','primary','document','dry-run']);
      const projectId=identifier(opts.project);if(!opts.file) fail('USAGE','请提供 --file 文件路径。');
      const buffer=await fs.readFile(opts.file);
      if(!buffer.length || buffer.length>2*1024*1024) fail('FILE_TOO_LARGE','文档应为非空文件且不超过 2 兆字节。');
      try {new TextDecoder('utf-8',{fatal:true}).decode(buffer);} catch {fail('INVALID_FILE','文档需要采用 UTF-8 编码。');}
      const body={name:path.basename(opts.file),content:buffer.toString('base64'),note:opts.note || ''};
      if(opts.document) {
        identifier(opts.document);
        if(opts.type || opts.title) fail('USAGE','上传新版本不修改类型和标题；需要时请在网页中修改。');
        const existing=opts['dry-run']?null:(await client.request(`/api/projects/${projectId}/documents`)).data.documents.find(item=>item.id===opts.document);
        if(!opts['dry-run'] && !existing) fail('NOT_FOUND','项目中没有这个文档编号，请先 document list 查询。');
        Object.assign(body,{documentId:opts.document,...(existing?{name:existing.name,expectedVersion:existing.version}:{})});
      } else Object.assign(body,{type:opts.type || 'PRD',...(opts.title?{title:opts.title}:{})});
      if(opts.primary) body.primary=true;
      const endpoint=`/api/projects/${projectId}/documents`;
      if(opts['dry-run']) return result({previewOnly:true,serverValidated:false,method:'POST',endpoint,body:{...body,content:`（${buffer.length} 字节，已省略）`}});
      return result((await client.request(endpoint,{method:'POST',body})).data);
    }
    fail('USAGE','文档命令格式错误，使用 --help 查看。');
  }
  if(group==='requirement' && action==='import' && pos.length===2) {
    allowed(opts,['project','data','data-file','dry-run']);
    const projectId=identifier(opts.project),items=await listPayload(opts,'requirements');
    const {data}=await client.request('/api/bootstrap');
    if(!data.projects.some(project=>project.id===projectId)) fail('NOT_FOUND','没有这个项目或无权访问，请先 project list 查询。');
    const documents=(await client.request(`/api/projects/${projectId}/documents`)).data.documents;
    const existing=new Map(data.requirements.filter(item=>item.projectId===projectId && !item.archived).map(item=>[item.title.trim(),item.id]));
    const warnings=[],plan=[],seen=new Set();
    items.forEach((item,index)=>{
      const {key,...body}=item,where=`第 ${index+1} 条「${body.title || ''}」`;
      if(body.projectId!==undefined && body.projectId!==projectId) fail('USAGE',`${where} 的 projectId 与 --project 不一致。`);
      body.projectId=projectId;
      for(const field of Object.keys(body)) if(!SCHEMA.requirement.create.includes(field)) fail('USAGE',`${where} 不支持字段：${field}`);
      if(typeof body.title!=='string' || !body.title.trim()) fail('USAGE',`${where} 缺少标题。`);
      if(seen.has(body.title.trim())) fail('USAGE',`${where} 与本文件中的另一条需求同名。`);seen.add(body.title.trim());
      for(const ref of body.docRefs || []) {
        const doc=documents.find(documentItem=>documentItem.name===ref.document);
        if(!doc) {warnings.push(`${where}：文档 ${ref.document} 尚未上传，章节无法校验`);continue;}
        const codes=new Set(doc.sections.map(section=>section.code)),unknown=(ref.sections || []).filter(code=>!codes.has(code));
        if(unknown.length) warnings.push(`${where}：${ref.document} 中找不到章节 ${unknown.join('、')}`);
      }
      const caseCodes=new Set(documents.filter(doc=>doc.type==='验收用例').flatMap(doc=>doc.sections.map(section=>section.code)));
      const unknownCases=(body.acceptanceCases || []).filter(code=>caseCodes.size && !caseCodes.has(code));
      if(unknownCases.length) warnings.push(`${where}：验收用例文档中找不到 ${unknownCases.join('、')}`);
      if(!body.acceptance) warnings.push(`${where}：没有填写验收标准，之后无法流转到「已确定」`);
      plan.push({key:key ?? null,title:body.title,existingId:existing.get(body.title.trim()) || null,body});
    });
    if(opts['dry-run']) return result({previewOnly:true,create:plan.filter(item=>!item.existingId).map(item=>({key:item.key,title:item.title})),exists:plan.filter(item=>item.existingId).map(item=>({key:item.key,title:item.title,id:item.existingId})),warnings});
    const results=[];
    for(const item of plan) {
      if(item.existingId) {results.push({key:item.key,title:item.title,id:item.existingId,result:'exists'});continue;}
      try {const created=(await client.request('/api/requirements',{method:'POST',body:item.body})).data;results.push({key:item.key,title:item.title,id:created.id,result:'created'});}
      catch(error) {error.message+=` 已处理 ${results.length} 条，重新执行同一命令会跳过已创建的需求。`;error.details={results,failed:item.title};throw error;}
    }
    return result({items:results,created:results.filter(item=>item.result==='created').length,existing:results.filter(item=>item.result==='exists').length,warnings});
  }
  if(group==='plan' && ['preview','apply'].includes(action) && pos.length===2) {
    allowed(opts,['project','data','data-file',...(action==='apply'?['force']:[])]);
    const projectId=identifier(opts.project),plan=validatePlan(await objectPayload(opts));
    const {data}=await client.request('/api/bootstrap');
    const project=data.projects.find(item=>item.id===projectId);if(!project) fail('NOT_FOUND','没有这个项目或无权访问。');
    const members=data.memberships.filter(item=>item.projectId===projectId),users=new Map(data.users.map(item=>[item.id,item]));
    const aliases=plan.owners || {};
    const resolveOwner=value=>{
      const name=aliases[value] ?? value,user=users.get(name) || data.users.find(item=>item.username===name);
      if(!user) fail('INVALID_PLAN',`找不到负责人 ${value}，请用 project members 查询用户名。`);
      const member=members.find(item=>item.userId===user.id);
      if(!member) fail('INVALID_PLAN',`${user.name}（${user.username}）不是该项目成员。`);
      return user.id;
    };
    const owners=new Map();for(const task of plan.tasks) owners.set(task.owner,resolveOwner(task.owner));
    const warnings=[];
    for(const [alias,userId] of owners) {const role=members.find(item=>item.userId===userId).role;if(!['lead','developer'].includes(role)) warnings.push(`${users.get(userId).name} 在项目中的角色是 ${role}，通常任务负责人应为主开发或开发`);}
    const requirementIds=[...new Set(plan.tasks.map(task=>task.requirement))];
    const requirements=new Map();
    for(const id of requirementIds) {
      const item=data.requirements.find(requirement=>requirement.id===id);
      if(!item || item.projectId!==projectId || item.archived) fail('INVALID_PLAN',`需求 ${id} 不在该项目中或已归档，请用 requirement list 查询编号。`);
      requirements.set(id,item);
    }
    const stage=status=>({'待开始':'wait','开发中':'develop','测试中':'test','已完成':'done','已终止':'terminated'}[status] || status);
    const busyUntil={};
    for(const task of data.tasks) if(!task.archived && !['done','terminated'].includes(stage(task.status)) && task.dueDate && !requirementIds.includes(task.requirementId) && (!busyUntil[task.ownerId] || task.dueDate>busyUntil[task.ownerId])) busyUntil[task.ownerId]=task.dueDate;
    const schedule=schedulePlan(plan,{busyUntil,ownerOf:value=>owners.get(value)});
    const planKey=createHash('sha256').update(JSON.stringify(plan)).digest('hex').slice(0,12);
    const name=id=>users.get(id)?.username || id;
    const rows=schedule.requirements.map(entry=>{
      const requirement=requirements.get(entry.requirementId),live=data.tasks.filter(task=>task.requirementId===entry.requirementId && !task.archived);
      const planTitles=new Set(entry.tasks.map(task=>task.title)),fromThisPlan=live.length>0 && live.length===entry.tasks.length && live.every(task=>planTitles.has(task.title));
      return {requirementId:entry.requirementId,title:requirement.title,status:requirement.status,version:requirement.version,planStart:entry.planStart,planEnd:entry.planEnd,assignee:name(entry.assignee),collaborators:entry.collaborators.map(name),hours:entry.hours,
        late:Boolean(project.targetDate && entry.planEnd>project.targetDate),skip:live.length && !fromThisPlan?`已有 ${live.length} 个其他任务`:null,alreadyCreated:fromThisPlan,
        tasks:entry.tasks.map(task=>({title:task.title,owner:name(task.owner),phase:task.phase ?? '',hours:task.hours,startDate:task.startDate,dueDate:task.dueDate})),entry};
    });
    const late=rows.filter(row=>row.late && !row.skip).map(row=>`${row.requirementId} ${row.title}：计划 ${row.planEnd}，晚于项目目标 ${project.targetDate}`);
    const phaseLate=Object.entries(plan.phaseDeadlines || {}).filter(([phase,deadline])=>schedule.phaseEnds[phase] && schedule.phaseEnds[phase]>deadline).map(([phase,deadline])=>`阶段 ${phase} 最晚 ${schedule.phaseEnds[phase]}，晚于节点 ${deadline}`);
    const notConfirmed=rows.filter(row=>!row.skip && !['已确定','已排期'].includes(row.status)).map(row=>`${row.requirementId} ${row.title}：当前「${row.status}」，只会写入任务和计划日期，确认后再流转`);
    const summary={project:{id:project.id,name:project.name,targetDate:project.targetDate || null},planKey,tasks:schedule.tasks.length,requirements:rows.length,granularity:schedule.granularity,
      load:Object.fromEntries(Object.entries(schedule.load).map(([id,item])=>[name(id),{...item,startsAfterExisting:busyUntil[id] || null}])),phaseEnds:schedule.phaseEnds,late,phaseLate,notConfirmed,warnings,skipped:rows.filter(row=>row.skip).map(row=>`${row.requirementId} ${row.title}：${row.skip}，跳过`)};
    if(action==='preview') return result({...summary,previewOnly:true,requirements:rows.map(({entry,version,...row})=>row)});
    const me=data.currentUser,role=me.role==='admin'?'admin':members.find(item=>item.userId===me.id)?.role;
    if(!['admin','lead'].includes(role)) fail('FORBIDDEN','拆分任务并指派给他人需要主开发或管理员账号，请用对应账号登录后再执行。');
    if(late.length && !opts.force) fail('CONFIRMATION_REQUIRED',`有 ${late.length} 条需求计划晚于项目目标日期，未写入。确认接受后加 --force。`,{details:late});
    const done=[];
    for(const row of rows) {
      if(row.skip) {done.push({requirementId:row.requirementId,result:'skipped',reason:row.skip});continue;}
      try {
        let created=0;
        if(!row.alreadyCreated) {
          const version=(await client.request(`/api/requirements/${row.requirementId}`)).data.version;
          const batch=(await client.request(`/api/requirements/${row.requirementId}/task-batch`,{method:'POST',body:{version,requestId:`plan-${planKey}-${row.requirementId}`,tasks:row.entry.tasks.map(task=>({title:task.title,ownerId:task.owner,startDate:task.startDate,dueDate:task.dueDate,estimateHours:task.hours,description:task.desc || ''}))}})).data;
          created=batch.replayed?0:batch.tasks.length;
        }
        const current=(await client.request(`/api/requirements/${row.requirementId}`)).data;
        const body={version:current.version,assigneeId:row.entry.assignee,collaboratorIds:row.entry.collaborators,planStart:row.planStart,planEnd:row.planEnd,...(current.status==='已确定'?{status:'已排期'}:{}),...(row.late?{force:true}:{})};
        const updated=(await client.request(`/api/requirements/${row.requirementId}`,{method:'PATCH',body})).data;
        done.push({requirementId:row.requirementId,result:'scheduled',createdTasks:created,status:updated.status,planStart:updated.planStart,planEnd:updated.planEnd});
      } catch(error) {error.message+=` 已完成 ${done.length} 条需求；重新执行同一计划会跳过已创建的任务。`;error.details={done,failed:row.requirementId};throw error;}
    }
    return result({...summary,items:done});
  }
  if(group==='work' && pos.length===1) {
    allowed(opts,['date']);if(opts.date) date(opts.date);
    return result((await client.request('/api/work'+(opts.date?`?date=${opts.date}`:''))).data);
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
