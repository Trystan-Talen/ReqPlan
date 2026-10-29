import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {Client,Store,fail,normalizeUrl} from './client.mjs';
import {schedulePlan,validatePlan} from './plan.mjs';
import {VERSION} from './version.mjs';

const HELP=`星河命令行工具 — 默认输出 JSON（结构化数据）

配置与账号：
  xinghe config set-url <平台地址> --profile local [--allow-http]
  xinghe config show --profile local
  xinghe auth login --username admin --profile local
  xinghe auth me | logout
  xinghe health

查询与操作：
  xinghe project list
  xinghe project get <编号>
  xinghe project members <编号>
  xinghe proposal list --project <项目编号>
  xinghe proposal get|history <编号>
  xinghe proposal create --project <编号> --title <标题> [--data-file 文件]
  xinghe proposal import --project <编号> --data-file 提议数组.json [--dry-run]
  xinghe proposal update|approve <编号> --version <版本号> [--data-file 文件]
  xinghe requirement list --project <项目编号> [--assignee 主责开发编号] [--query 关键词]
  xinghe requirement get <编号>
  xinghe requirement history <编号>
  xinghe requirement create --project <编号> --title <标题> [--data-file 文件]
  xinghe requirement import --project <编号> --data-file 需求数组.json [--dry-run]   （同名跳过，不保证并发去重）
  xinghe requirement update <编号> --version <版本号> --data-file 文件
  xinghe requirement schedule <编号> --version <版本号> --start YYYY-MM-DD --end YYYY-MM-DD
  xinghe requirement archive|restore <编号> --version <版本号>
  xinghe requirement return <编号> --version <版本号> --reason <原因> --data-file 返工任务.json
  xinghe requirement reopen <编号> --version <版本号> --reason <原因>
  xinghe task list --project <项目编号>
  xinghe task get <编号>
  xinghe task history <编号>
  xinghe task create --project <编号> --requirement <需求编号> --title <标题>
  xinghe task update <编号> --version <版本号> --data-file 文件
  xinghe task schedule <编号> --version <版本号> --start YYYY-MM-DD --end YYYY-MM-DD
  xinghe task batch --requirement <需求编号> --version <需求版本号> --data-file 任务数组.json [--request-id 提交编号]
  xinghe task archive|restore <编号> --version <版本号>
  xinghe schedule list [--project <编号>] [--kind task|requirement] [--basis development|commitment] [--from YYYY-MM-DD --to YYYY-MM-DD]
  xinghe schedule preview --project <编号> --data-file 改期.json
  xinghe schedule apply --project <编号> --data-file 改期.json --token <预览令牌> --reason <原因> [--force]
  xinghe document list --project <编号>
  xinghe document versions <文档编号>
  xinghe document download <文档编号> [--doc-version 版本] [--output 文件]
  xinghe document upload --project <编号> --file 路径 [--type PRD|原型|技术方案|验收用例|其他] [--title 标题] [--note 说明] [--primary]
  xinghe document upload --project <编号> --document <文档编号> --file 路径 [--note 说明]   （上传新版本）
  xinghe work [--date YYYY-MM-DD]   （我的工作与站内提醒）
  xinghe plan preview --project <编号> --data-file 计划.json   （按日历与产能自动排期，不写入）
  xinghe plan apply --project <编号> --data-file 计划.json [--force]   （建任务、设主责，保留需求承诺日期）
  xinghe --version
  xinghe schema

全局参数：--profile 环境名（默认 default）；--url 地址（仅本次覆盖）
地址优先级：--url > XINGHE_URL（环境变量）> 当前环境配置。没有内置端口。
远程 HTTP（未加密连接）须在 config set-url 时用 --allow-http（允许未加密连接）明确许可，仅对该环境的完整地址生效。
地址填写平台入口，不带 /#/ 后的页面路径；配置一次后登录、查询和写入无需重复许可。
读取参数：--project、--owner、--status、--query、--include-archived
写入参数：--title、--description、--owner、--status、--priority、--hours、--points
写入文件：--data-file 文件或 -（标准输入）；--data JSON字符串；二者不能同时使用。
--dry-run 只读预览，不写入；批量导入会查询项目和文档，不代表后端校验通过。
proposal（提议）用于待评估内容；requirement（需求）直接创建已确认需求，必须提供背景和验收标准。
研发阶段由任务自动同步；需求验收、退回、重开仍须人工操作。
登录默认终端隐藏输入；自动化可用 --password-stdin 从安全输入通道读取。
修改必须使用刚查询的 version（版本号），冲突不会自动覆盖。创建不会自动重试；task batch 可用同一 --request-id 安全重试。
schema（字段说明）列出高级字段；--help 查看帮助。`;
const SCHEMA={
  proposal:{create:['projectId','title','description','acceptance','source','priority','proposerName','docRefs','acceptanceCases'],update:['version','title','description','acceptance','source','priority','proposerName','docRefs','acceptanceCases','status','decisionReason'],approve:['version','title','description','acceptance','source','priority','proposerName','docRefs','acceptanceCases','decisionReason','ownerId'],statuses:['待评估','评估中','待补充','暂缓','不采纳','已转需求'],notes:'项目成员可提出提议；产品经理或管理员评估并 approve（确认转需求）。确认时背景与验收标准必填，返回关联需求。历史早期需求也在此评估，保留原编号和关联。'},
  requirement:{create:['projectId','title','description','acceptance','source','status','priority','ownerId','assigneeId','collaboratorIds','planStart','planEnd','estimatePoints','dependencyIds','docRefs','acceptanceCases'],update:['version','title','description','acceptance','source','status','priority','ownerId','assigneeId','collaboratorIds','planStart','planEnd','estimatePoints','dependencyIds','docRefs','acceptanceCases','reason','force'],
    docRefs:'[{"document":"文档文件名","type":"PRD|原型|技术方案|验收用例|其他","sections":["章节编号"]}]；PRD 章节编号取标题里的〔编号〕，技术方案取 §n.n，验收用例取每个 Scenario 的第一个 @标签。acceptanceCases 为验收用例编号列表。只有产品经理和管理员能修改。',
    statuses:['未确定','待评审','已确定','待排期','已排期','开发中','测试中','已完成','已终止'],
    notes:'产品经理或管理员直接创建「已确定」需求，description（背景与目标）和 acceptance（验收标准）必填。历史「未确定 / 待评审」通过 proposal（提议）评估。研发阶段按任务自动同步，不手动推进。assigneeId（主责开发）由主开发指定；dependencyIds（前置需求）未完成时不能开工。planStart / planEnd（承诺起止日期）独立保留，任务日期表示研发周期。docRefs（文档关联）可由产品经理和管理员修改；sections（章节）为空表示全文。验收、退回、重开由产品经理、主开发、测试或管理员处理。'},
  requirementActions:{return:{fields:['version','reason','taskIds'],notes:'退回测试中的需求，选择至少一个测试中或已完成任务返工。'},reopen:{fields:['version','reason'],notes:'重新打开已完成或已终止的需求。'}},
  task:{create:['projectId','requirementId','title','description','ownerId','startDate','dueDate','estimateHours','estimatePoints','dependencyIds'],update:['version','requirementId','title','description','ownerId','status','startDate','dueDate','estimateHours','estimatePoints','dependencyIds','reason'],
    statuses:['wait（待开始）','develop（开发中）','test（测试中）','done（已完成）','terminated（已终止）'],
    notes:'任务必须关联需求。主开发可给任何成员派任务；开发只能给自己建任务。新任务从待开始创建；不能验收自己负责的任务（主开发的纯技术任务除外）。日期采用 YYYY-MM-DD。'},
  taskBatch:{file:'任务对象数组，或 {"tasks":[…]}；每项字段同 task.create（projectId、requirementId 可省略），1 至 100 条，整包校验、要么全部创建要么不创建。',requestId:'同一 --request-id 重复提交返回首次结果，不会重复创建。'},
  scheduleChanges:{file:'改期数组，或 {"changes":[…]}；每项 {requirementId, version, planStart, planEnd}，1 至 100 条。',flow:'先 schedule preview 取得 previewToken，再用同一文件 schedule apply；超出项目目标日期需加 --force。'},
  requirementImport:{file:'需求对象数组，或 {"requirements":[…]}；字段同 requirement.create（projectId 可省略），可加 key 作为本地标识。',behavior:'直接创建已确定需求，背景和验收标准必填。按标题跳过已有未归档需求；只做客户端查重，不保证并发幂等。先预览并核对关联文档。'},
  proposalImport:{file:'提议对象数组，或 {"proposals":[…]}；字段同 proposal.create，可加 key（本地标识）。',behavior:'创建待评估提议，按标题跳过已有提议；确认需求使用 proposal approve（确认转需求），不会自动确认。'},
  plan:{file:'{startDate, capacityHours, capacityOverrides?, holidays?, extraWorkdays?, acceptanceBufferDays?(默认 1), phases?, phaseDeadlines?, owners?, respectExistingLoad?(默认 true), tasks:[{requirement:需求编号, owner:用户名|成员编号|owners 别名, phase?, hours, title, desc?, after?:[前置任务标题]}]}',
    behavior:'按阶段与文件顺序安排任务，默认接在已有未完成工作之后。apply（应用）需要主开发或管理员，只接受已确认且未结束需求；建任务并设置主责协作，由后端同步阶段。建议交付日期含验收缓冲，仅供参考，不写入需求承诺日期或基线。已有任务跳过；重跑不覆盖人工改动。晚于项目目标或已有承诺时需 --force（接受延期）。after（前置任务标题）只约束本次日期计算，不创建服务端任务依赖。'},
  notes:'数组、数字、布尔值请用结构化数据文件；成员编号通过 project members 查询。最终校验由后端负责。'
};
const FLAGS=new Set(['help','include-archived','dry-run','password-stdin','force','primary','allow-http']);
const VALUES=new Set(['profile','url','username','project','owner','assignee','status','query','from','to','title','description','acceptance','proposer','decision-reason','priority','requirement','hours','points','version','start','end','data-file','data','request-id','token','reason','kind','basis','doc-version','output','file','type','note','document','date']);
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
  const map={project:'projectId',requirement:'requirementId',owner:'ownerId',assignee:'assigneeId',title:'title',description:'description',acceptance:'acceptance',proposer:'proposerName','decision-reason':'decisionReason',reason:'reason',status:'status',priority:'priority',hours:'estimateHours',points:'estimatePoints',version:'version'};
  for(const [flag,key] of Object.entries(map)) if(opts[flag]!==undefined) {
    if(Object.hasOwn(value,key)) fail('USAGE',`文件与参数重复指定字段：${key}`);
    value[key]=['hours','points','version'].includes(flag)?Number(opts[flag]):opts[flag];
    if(['hours','points','version'].includes(flag) && (!opts[flag].trim() || !Number.isFinite(value[key]) || value[key]<0)) fail('USAGE',`--${flag} 必须是有效非负数字。`);
  }
  if(opts.force) {if(Object.hasOwn(value,'force')) fail('USAGE','文件与参数重复指定字段：force');value.force=true;}
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
function resolveUrl(value,config) {
  const url=normalizeUrl(value,{allowHttp:true});
  const allowHttp=config.url===url && config.httpAllowedUrl===url;
  return {url:normalizeUrl(url,{allowHttp}),allowHttp};
}
export async function run(args,{store=new Store(),fetchImpl=fetch,passwordReader=readPassword,env=process.env}={}) {
  if(args.length===1 && ['--version','-v'].includes(args[0])) return VERSION;
  const {opts,pos}=parse(args);
  if(opts.help || !pos.length) return HELP;
  const [group,action,id]=pos;
  if(group==='schema' && pos.length===1) {allowed(opts,[]);return {data:SCHEMA};}
  const profile=opts.profile || 'default';
  if(!/^[a-zA-Z0-9_-]{1,40}$/.test(profile)) fail('USAGE','环境名称限 1 至 40 位字母、数字、下划线或连字符。');
  const configName=`profile-${profile}.json`;
  const config=await store.read(configName,{});
  if(group==='config') {
    if(action==='set-url' && pos.length===3) {
      allowed(opts,['allow-http']);
      if(opts.url) fail('USAGE','set-url 命令请直接提供地址，不使用 --url。');
      const url=normalizeUrl(id,{allowHttp:Boolean(opts['allow-http'])});
      const httpAllowedUrl=opts['allow-http'] && new URL(url).protocol==='http:' ? url : null;
      await store.write(configName,{url,...(httpAllowedUrl?{httpAllowedUrl}:{})});
      return {data:{profile,url,httpAllowedUrl,note:httpAllowedUrl?'地址已保存，并已为本环境的该地址允许 HTTP（未加密连接）；密码和会话将以明文传输。新地址需要独立登录。':'地址已保存；新地址需要独立登录。'}};
    }
    if(action==='show' && pos.length===2) {
      allowed(opts,[]);
      const selected=opts.url || env.XINGHE_URL || config.url;
      const resolved=selected?resolveUrl(selected,config):null;
      return {data:{profile,url:resolved?.url || null,configuredUrl:config.url || null,httpAllowedUrl:resolved?.allowHttp?resolved.url:null}};
    }
    fail('USAGE','配置命令格式错误，使用 --help 查看。');
  }
  const selected=opts.url || env.XINGHE_URL || config.url;
  if(!selected) fail('URL_REQUIRED','请先 config set-url 配置平台地址，或提供 --url。');
  const client=new Client({...resolveUrl(selected,config),profile,store,fetchImpl});
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
  const plural={project:'projects',proposal:'proposals',requirement:'requirements',task:'tasks'}[group];
  if((plural || group==='schedule') && action==='list' && pos.length===2) {
    allowed(opts,['project','owner','status','query','include-archived',...(group==='requirement'?['assignee']:[]),...(group==='schedule'?['from','to','kind','basis']:[])]);
    if(opts.kind && !['task','requirement'].includes(opts.kind)) fail('USAGE','--kind 只能是 task 或 requirement。');
    if(opts.basis && ((opts.kind || 'task')!=='requirement' || !['development','commitment'].includes(opts.basis))) fail('USAGE','--basis 仅用于需求排期，取 development（研发）或 commitment（承诺）。');
    if(opts.project) identifier(opts.project);
    if(opts.from) date(opts.from);if(opts.to) date(opts.to);
    if(opts.from && opts.to && opts.from>opts.to) fail('USAGE','开始日期不能晚于结束日期。');
    const {data}=await client.request('/api/bootstrap'+(opts['include-archived']?'?includeArchived=1':''));
    const kind=group==='schedule'?(opts.kind || 'task'):null;
    let items=data[plural || (kind==='requirement'?'requirements':'tasks')];
    if(group==='requirement' || kind==='requirement') items=items.filter(x=>!['未确定','待评审'].includes(x.status));
    if(kind==='requirement') items=items.map(x=>{
      const valid=value=>{try{return date(value);}catch{return '';}};
      const tasks=(data.tasks || []).filter(task=>task.requirementId===x.id && !task.archived && !['terminated','已终止'].includes(task.status));
      const dates=tasks.map(task=>({start:valid(task.startDate),end:valid(task.dueDate)})).filter(task=>!task.start || !task.end || task.start<=task.end);
      const developmentStart=dates.map(task=>task.start).filter(Boolean).sort()[0] || '',developmentEnd=dates.map(task=>task.end).filter(Boolean).sort().at(-1) || '';
      const useTasks=opts.basis!=='commitment' && Boolean(developmentStart || developmentEnd);
      return {...x,developmentStart,developmentEnd,commitmentStart:x.planStart || '',commitmentEnd:x.planEnd || '',dateSource:useTasks?'tasks':'commitment',startDate:useTasks?developmentStart:x.planStart,dueDate:useTasks?developmentEnd:x.planEnd};
    });
    if(opts.project) items=items.filter(x=>group==='project'?x.id===opts.project:x.projectId===opts.project);
    if(opts.owner) items=items.filter(x=>x.ownerId===opts.owner);
    if(opts.assignee) items=items.filter(x=>x.assigneeId===opts.assignee);
    if(opts.status) items=items.filter(x=>x.status===opts.status);
    if(opts.query) {const q=opts.query.toLocaleLowerCase();items=items.filter(x=>[x.id,x.title,x.name,x.description].some(s=>String(s || '').toLocaleLowerCase().includes(q)));}
    if(group==='schedule') {
      const unscheduled=items.filter(x=>!x.startDate || !x.dueDate || x.startDate>x.dueDate);
      items=items.filter(x=>x.startDate && x.dueDate && x.startDate<=x.dueDate && (!opts.from || x.dueDate>=opts.from) && (!opts.to || x.startDate<=opts.to)).sort((a,b)=>a.startDate.localeCompare(b.startDate));
      return result({kind,...(kind==='requirement'?{basis:opts.basis || 'development'}:{}),items,count:items.length,unscheduled,note:kind==='requirement'?'默认使用有效任务的研发区间，无任务日期时回退承诺；dateSource（日期来源）标明 tasks（任务）或 commitment（承诺）。--basis commitment 单独查询承诺。':'未完整排期的任务单独列出；此列表不计算人员负荷或任务依赖。'});
    }
    return result({items,count:items.length});
  }
  if(plural && pos.length===3 && ['get','members','history'].includes(action)) {
    allowed(opts,[]);identifier(id);
    if(action==='members' && group!=='project' || action==='history' && group==='project') fail('USAGE','此对象不支持该命令。');
    return result((await client.request(`/api/${plural}/${id}`+(action==='get'?'':`/${action}`))).data);
  }
  if(group==='requirement' && ['return','reopen'].includes(action) && pos.length===3) {
    allowed(opts,['version','reason','data','data-file','dry-run']);identifier(id);
    const body=await payload(opts),fields=SCHEMA.requirementActions[action].fields;
    for(const key of Object.keys(body)) if(!fields.includes(key)) fail('USAGE',`此操作不支持字段：${key}`);
    if(!Number.isSafeInteger(body.version) || body.version<1) fail('VERSION_REQUIRED','请提供需求当前版本号。');
    if(typeof body.reason!=='string' || !body.reason.trim()) fail('USAGE','请填写操作原因。');
    if(action==='return') {
      if(!Array.isArray(body.taskIds) || !body.taskIds.length || body.taskIds.length>100) fail('USAGE','退回必须提供 1 至 100 个返工任务编号 taskIds（任务编号列表）。');
      body.taskIds.forEach(identifier);
    }
    const endpoint=`/api/requirements/${id}/${action}`;
    if(opts['dry-run']) return result({previewOnly:true,serverValidated:false,method:'POST',endpoint,body});
    return result((await client.request(endpoint,{method:'POST',body})).data);
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
  if(['requirement','proposal'].includes(group) && action==='import' && pos.length===2) {
    allowed(opts,['project','data','data-file','dry-run']);
    const projectId=identifier(opts.project),items=await listPayload(opts,plural);
    const {data}=await client.request('/api/bootstrap');
    if(!data.projects.some(project=>project.id===projectId)) fail('NOT_FOUND','没有这个项目或无权访问，请先 project list 查询。');
    const documents=(await client.request(`/api/projects/${projectId}/documents`)).data.documents;
    const existing=new Map(data[plural].filter(item=>item.projectId===projectId && !item.archived && (group!=='requirement' || !['未确定','待评审'].includes(item.status))).map(item=>[item.title.trim(),item.id]));
    const warnings=[],errors=[],plan=[],seen=new Set();
    items.forEach((item,index)=>{
      const {key,...body}=item,where=`第 ${index+1} 条「${body.title || ''}」`;
      if(body.projectId!==undefined && body.projectId!==projectId) fail('USAGE',`${where} 的 projectId 与 --project 不一致。`);
      body.projectId=projectId;
      for(const field of Object.keys(body)) if(!SCHEMA[group].create.includes(field)) fail('USAGE',`${where} 不支持字段：${field}`);
      if(typeof body.title!=='string' || !body.title.trim()) fail('USAGE',`${where} 缺少标题。`);
      if(seen.has(body.title.trim())) fail('USAGE',`${where} 与本文件中的另一条需求同名。`);seen.add(body.title.trim());
      if(body.docRefs!==undefined && (!Array.isArray(body.docRefs) || body.docRefs.some(ref=>!ref || typeof ref.document!=='string' || ref.sections!==undefined && (!Array.isArray(ref.sections) || ref.sections.some(code=>typeof code!=='string'))))) fail('USAGE',`${where} 的 docRefs（文档引用）格式无效。`);
      if(body.acceptanceCases!==undefined && (!Array.isArray(body.acceptanceCases) || body.acceptanceCases.some(code=>typeof code!=='string'))) fail('USAGE',`${where} 的 acceptanceCases（验收用例）必须是文本数组。`);
      for(const ref of body.docRefs || []) {
        const doc=documents.find(documentItem=>documentItem.name===ref.document);
        if(!doc) {warnings.push(`${where}：文档 ${ref.document} 尚未上传，章节无法校验`);continue;}
        const codes=new Set(doc.sections.map(section=>section.code)),unknown=(ref.sections || []).filter(code=>!codes.has(code));
        if(unknown.length) warnings.push(`${where}：${ref.document} 中找不到章节 ${unknown.join('、')}`);
      }
      const caseCodes=new Set(documents.filter(doc=>doc.type==='验收用例').flatMap(doc=>doc.sections.map(section=>section.code)));
      const unknownCases=(body.acceptanceCases || []).filter(code=>!caseCodes.has(code));
      if(unknownCases.length) warnings.push(`${where}：验收用例文档中找不到 ${unknownCases.join('、')}`);
      if(group==='requirement' && !existing.has(body.title.trim())) {
        if((data.proposals || []).some(proposal=>proposal.projectId===projectId && !proposal.archived && proposal.status!=='已转需求' && proposal.title.trim()===body.title.trim())) errors.push(`${where}：存在同名待评估提议，请用 proposal approve（确认转需求）保留原编号及关联。`);
        if(typeof body.description!=='string' || !body.description.trim() || typeof body.acceptance!=='string' || !body.acceptance.trim()) errors.push(`${where}：已确认需求必须填写 description（背景与目标）和 acceptance（验收标准）；待评估内容请用 proposal import（导入提议）。`);
        if(body.status && body.status!=='已确定') errors.push(`${where}：新需求状态只能是「已确定」。`);
      }
      plan.push({key:key ?? null,title:body.title,existingId:existing.get(body.title.trim()) || null,body});
    });
    if(opts['dry-run']) return result({previewOnly:true,serverValidated:false,create:plan.filter(item=>!item.existingId).map(item=>({key:item.key,title:item.title})),exists:plan.filter(item=>item.existingId).map(item=>({key:item.key,title:item.title,id:item.existingId})),warnings,errors});
    if(errors.length) fail('INVALID_IMPORT','导入预检未通过，未写入任何记录。',{details:errors});
    const results=[];
    for(const item of plan) {
      if(item.existingId) {results.push({key:item.key,title:item.title,id:item.existingId,result:'exists'});continue;}
      try {const created=(await client.request(`/api/${plural}`,{method:'POST',body:item.body})).data;results.push({key:item.key,title:item.title,id:created.id,result:'created'});}
      catch(error) {error.message+=` 已处理 ${results.length} 条；请先查询核对结果，同名记录会跳过，但并发导入不保证去重。`;error.details={results,failed:item.title,cause:error.details};throw error;}
    }
    return result({items:results,created:results.filter(item=>item.result==='created').length,existing:results.filter(item=>item.result==='exists').length,warnings});
  }
  if(group==='plan' && ['preview','apply'].includes(action) && pos.length===2) {
    allowed(opts,['project','data','data-file',...(action==='apply'?['force']:[])]);
    const projectId=identifier(opts.project),plan=validatePlan(await objectPayload(opts));
    const {data}=await client.request('/api/bootstrap?includeArchived=1');
    const project=data.projects.find(item=>item.id===projectId && !item.archived);if(!project) fail('NOT_FOUND','没有这个项目、项目已归档或无权访问。');
    const members=data.memberships.filter(item=>item.projectId===projectId),users=new Map(data.users.map(item=>[item.id,item]));
    const aliases=plan.owners || {};
    const resolveOwner=value=>{
      const name=Object.hasOwn(aliases,value)?aliases[value]:value,user=users.get(name) || data.users.find(item=>item.username===name);
      if(!user || user.status==='disabled') fail('INVALID_PLAN',`找不到有效负责人 ${value}，请用 project members（项目成员）查询。`);
      if(!members.some(item=>item.userId===user.id)) fail('INVALID_PLAN',`${user.name}（${user.username}）不是该项目成员。`);
      return user.id;
    };
    const planKey=createHash('sha256').update(JSON.stringify(plan)).digest('hex').slice(0,12);
    const requirementIds=[...new Set(plan.tasks.map(task=>task.requirement))],requirements=new Map(),prior=new Map();
    const blocked=[],notConfirmed=[],warnings=[];
    for(const id of requirementIds) {
      const item=data.requirements.find(requirement=>requirement.id===id);
      if(!item || item.projectId!==projectId || item.archived) fail('INVALID_PLAN',`需求 ${id} 不在该项目中或已归档，请用 requirement list（需求列表）查询编号。`);
      requirements.set(id,item);
      const existing=data.tasks.filter(task=>task.requirementId===id),live=existing.filter(task=>!task.archived);
      // Use the server's audit trail as provenance. Equal titles alone are not proof
      // that these tasks belong to this plan; retries never overwrite manual edits.
      const history=(await client.request(`/api/requirements/${id}/history`)).data.entries;
      const batchHistory=history.find(entry=>entry.action==='split_tasks' && entry.detail?.requestId===`plan-${planKey}-${id}`),alreadyCreated=Boolean(batchHistory);
      if(!alreadyCreated && !existing.length) {
        if(plan.tasks.filter(task=>task.requirement===id).length>100) blocked.push(`${id}：一次最多拆分 100 个任务。`);
        if(['未确定','待评审'].includes(item.status)) {const message=`${id} ${item.title}：请先通过 proposal approve（确认提议）纳入需求池。`;blocked.push(message);notConfirmed.push(message);}
        if(['已完成','已终止'].includes(item.status)) blocked.push(`${id} ${item.title}：需求已结束，请先使用 requirement reopen（重新打开需求）。`);
      }
      prior.set(id,{live,alreadyCreated,batchTaskIds:new Set(batchHistory?.detail.taskIds || []),skip:existing.length && !alreadyCreated?`已有 ${existing.length} 个其他任务（含归档），无法确认来自本计划`:null});
    }
    const pendingIds=new Set(requirementIds.filter(id=>!prior.get(id).alreadyCreated && !prior.get(id).skip));
    const stage=status=>({'待开始':'wait','开发中':'develop','测试中':'test','已完成':'done','已终止':'terminated'}[status] || status);
    const busyUntil=Object.create(null),activeProjects=new Set(data.projects.filter(item=>!item.archived).map(item=>item.id));
    const archivedRequirements=new Set(data.requirements.filter(item=>item.archived).map(item=>item.id));
    for(const task of data.tasks) if(activeProjects.has(task.projectId) && !archivedRequirements.has(task.requirementId) && !task.archived && !['done','terminated'].includes(stage(task.status)) && task.dueDate && !pendingIds.has(task.requirementId) && (!busyUntil[task.ownerId] || task.dueDate>busyUntil[task.ownerId])) busyUntil[task.ownerId]=task.dueDate;
    const pendingTasks=plan.tasks.filter(task=>pendingIds.has(task.requirement));
    const owners=new Map();for(const task of pendingTasks) owners.set(task.owner,resolveOwner(task.owner));
    const pendingTitles=new Set(pendingTasks.map(task=>task.title));
    const startsAfter=Object.create(null);
    const remainingTasks=pendingTasks.map(task=>({...task,after:(task.after || []).filter(title=>{
      if(pendingTitles.has(title)) return true;
      const original=plan.tasks.find(item=>item.title===title),previous=prior.get(original.requirement);
      const matches=previous.live.filter(item=>previous.batchTaskIds.has(item.id) && item.title===title && !['terminated','已终止'].includes(item.status));
      if(!previous.alreadyCreated || matches.length!==1 || !matches[0].dueDate) fail('INVALID_PLAN',`「${task.title}」依赖的已有任务「${title}」无法确认实际结束日，请核对后调整计划。`);
      date(matches[0].dueDate);
      if(!startsAfter[task.title] || matches[0].dueDate>startsAfter[task.title]) startsAfter[task.title]=matches[0].dueDate;
      return false;
    })}));
    const schedule=remainingTasks.length?schedulePlan({...plan,tasks:remainingTasks},{busyUntil,startsAfter,ownerOf:value=>owners.get(value)}):{tasks:[],requirements:[],load:{},phaseEnds:{},granularity:{averageHours:0,under8:0,over24:[]}};
    const name=id=>users.get(id)?.username || id;
    const rows=requirementIds.map(id=>{
      const requirement=requirements.get(id),{live,alreadyCreated,skip}=prior.get(id),entry=schedule.requirements.find(item=>item.requirementId===id);
      const active=live.filter(task=>stage(task.status)!=='terminated');
      const developmentStart=entry?.tasks.map(task=>task.startDate).sort()[0] || active.map(task=>task.startDate).filter(Boolean).sort()[0] || '';
      const developmentEnd=entry?.tasks.map(task=>task.dueDate).sort().at(-1) || active.map(task=>task.dueDate).filter(Boolean).sort().at(-1) || '';
      return {requirementId:id,title:requirement.title,status:requirement.status,version:requirement.version,
        planStart:entry?.planStart || '',planEnd:entry?.planEnd || '',developmentStart,developmentEnd,
        commitmentStart:requirement.planStart || '',commitmentEnd:requirement.planEnd || '',
        assignee:name(entry?.assignee || requirement.assigneeId),collaborators:(entry?.collaborators || requirement.collaboratorIds || []).map(name),hours:entry?.hours ?? active.reduce((sum,task)=>sum+(Number(task.estimateHours)||0),0),
        late:Boolean(entry && project.targetDate && entry.planEnd>project.targetDate),beyondCommitment:Boolean(entry && requirement.planEnd && developmentEnd>requirement.planEnd),skip,alreadyCreated,
        tasks:entry?entry.tasks.map(task=>({title:task.title,owner:name(task.owner),phase:task.phase ?? '',hours:task.hours,startDate:task.startDate,dueDate:task.dueDate})):live.map(task=>({id:task.id,title:task.title,owner:name(task.ownerId),hours:task.estimateHours,startDate:task.startDate,dueDate:task.dueDate})),entry};
    });
    const late=rows.filter(row=>row.late).map(row=>`${row.requirementId} ${row.title}：建议交付 ${row.planEnd}，晚于项目目标 ${project.targetDate}`);
    const beyondCommitment=rows.filter(row=>row.beyondCommitment).map(row=>`${row.requirementId} ${row.title}：研发结束 ${row.developmentEnd}，晚于现有承诺 ${row.commitmentEnd}；保留原承诺。`);
    const phaseLate=Object.entries(plan.phaseDeadlines || {}).filter(([phase,deadline])=>schedule.phaseEnds[phase] && schedule.phaseEnds[phase]>deadline).map(([phase,deadline])=>`阶段 ${phase} 最晚 ${schedule.phaseEnds[phase]}，晚于节点 ${deadline}`);
    const summary={project:{id:project.id,name:project.name,targetDate:project.targetDate || null},planKey,tasks:schedule.tasks.length,requirements:rows.length,granularity:schedule.granularity,
      load:Object.fromEntries(Object.entries(schedule.load).map(([id,item])=>[name(id),{...item,startsAfterExisting:busyUntil[id] || null}])),phaseEnds:schedule.phaseEnds,late,phaseLate,beyondCommitment,notConfirmed,blocked,warnings,
      skipped:rows.filter(row=>row.skip).map(row=>`${row.requirementId} ${row.title}：${row.skip}，跳过`),note:'planStart / planEnd（建议交付日期）仅供参考；不修改需求承诺日期与基线，研发阶段由后端按任务自动同步。'};
    if(action==='preview') return result({...summary,previewOnly:true,requirements:rows.map(({entry,version,...row})=>row)});
    const me=data.currentUser,role=me.role==='admin'?'admin':members.find(item=>item.userId===me.id)?.role;
    if(!['admin','lead'].includes(role)) fail('FORBIDDEN','拆分任务并指派给他人需要主开发或管理员账号。');
    if(blocked.length) fail('INVALID_PLAN','计划含不可排期需求，未写入任何记录。',{details:blocked});
    const risks=[...late,...beyondCommitment,...phaseLate];
    if(risks.length && !opts.force) fail('CONFIRMATION_REQUIRED','计划晚于项目目标、既有承诺或阶段节点，未写入。确认接受后加 --force。',{details:risks});
    const done=[];
    for(const row of rows) {
      if(row.skip) {done.push({requirementId:row.requirementId,result:'skipped',reason:row.skip,createdTasks:0});continue;}
      if(row.alreadyCreated) {done.push({requirementId:row.requirementId,result:'alreadyCreated',createdTasks:0,status:row.status,planStart:row.commitmentStart,planEnd:row.commitmentEnd});continue;}
      try {
        // Set assignment first; once the batch exists a retry can be completely
        // read-only. Keep the snapshot version so concurrent edits are rejected.
        const current=requirements.get(row.requirementId);
        let version=row.version;
        if(current.assigneeId!==row.entry.assignee || JSON.stringify(current.collaboratorIds || [])!==JSON.stringify(row.entry.collaborators)) {
          const updated=(await client.request(`/api/requirements/${row.requirementId}`,{method:'PATCH',body:{version,assigneeId:row.entry.assignee,collaboratorIds:row.entry.collaborators}})).data;
          version=updated.version;
        }
        const batch=(await client.request(`/api/requirements/${row.requirementId}/task-batch`,{method:'POST',body:{version,requestId:`plan-${planKey}-${row.requirementId}`,tasks:row.entry.tasks.map(task=>({title:task.title,ownerId:task.owner,startDate:task.startDate,dueDate:task.dueDate,estimateHours:task.hours,description:task.desc || ''}))}})).data;
        done.push({requirementId:row.requirementId,result:'scheduled',createdTasks:batch.replayed?0:batch.tasks.length,status:batch.requirement.status,planStart:batch.requirement.planStart,planEnd:batch.requirement.planEnd,developmentStart:row.developmentStart,developmentEnd:row.developmentEnd});
      } catch(error) {error.message+=` 已处理 ${done.length} 条需求；此计划不是跨需求事务，请先查询核对，再重跑同一文件。已有本计划任务不会覆盖。`;error.details={done,failed:row.requirementId,cause:error.details};throw error;}
    }
    return result({...summary,items:done});
  }
  if(group==='work' && pos.length===1) {
    allowed(opts,['date']);if(opts.date) date(opts.date);
    return result((await client.request('/api/work'+(opts.date?`?date=${opts.date}`:''))).data);
  }
  if(['requirement','task','proposal'].includes(group) && ['create','update','schedule',...(group==='proposal'?['approve']:[])].includes(action) && pos.length===(action==='create'?2:3)) {
    if(group==='proposal' && action==='schedule') fail('USAGE','提议需先确认转需求，再安排任务。');
    allowed(opts,['project','requirement','title','description','acceptance','owner','assignee','status','priority','hours','points','version','reason','data','data-file','dry-run',...(group==='proposal'?['proposer','decision-reason']:[]),...(group==='requirement' && action!=='create'?['force']:[]),...(action==='schedule'?['start','end']:[])]);
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
    const fields=SCHEMA[group][['create','approve'].includes(action)?action:'update'];
    for(const key of Object.keys(body)) if(!fields.includes(key)) fail('USAGE',`此操作不支持字段：${key}`);
    const endpoint=`/api/${plural}`+(action==='create'?'':`/${id}`)+(action==='approve'?'/approve':''),method=['create','approve'].includes(action)?'POST':'PATCH';
    if(opts['dry-run']) return result({previewOnly:true,serverValidated:false,method,endpoint,body});
    return result((await client.request(endpoint,{method,body})).data);
  }
  fail('USAGE','未知命令或参数数量错误，使用 --help 查看。');
}
