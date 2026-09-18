import test from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase} from '../database.mjs';
import {createAttachmentService} from '../attachments.mjs';

function fixture(t,{audit}={}) {
  const db=openDatabase(':memory:');t.after(()=>db.close());
  db.exec(`INSERT INTO users(id,username,name,role,status,must_change_password) VALUES('writer','writer','作者','admin','active',0);
    INSERT INTO projects(id,data) VALUES('p','{}');INSERT INTO requirements(id,project_id,data) VALUES('r','p','{}');`);
  const forbidden=()=>{const e=new Error('无权访问');e.status=403;throw e;};
  const authorizeRead=(actor)=>{if(!['writer','reader'].includes(actor.id))forbidden();};
  const authorizeWrite=(actor,row)=>{if(actor.id!=='writer'||row.archived)forbidden();return {user:{id:actor.id}};};
  const svc=createAttachmentService(db,{authorizeRead,authorizeWrite,audit:audit||(()=>{})});
  const upload=(text,extra={})=>svc.uploadAttachment({id:'writer'},'r',{name:'设计.md',mime:'text/markdown',contentBuffer:Buffer.from(text),...extra});
  return {db,svc,upload};
}

test('同名版本链只展示现用版本，旧地址及显式版本保留原内容',t=>{
  const {svc,upload}=fixture(t);const first=upload('第一版');
  assert.throws(()=>upload('无版本号'),e=>e.code==='VERSION_REQUIRED');
  const second=upload('第二版',{expectedVersion:1});
  assert.equal(second.logicalId,first.logicalId);assert.equal(second.version,2);
  assert.equal(svc.listAttachments({id:'reader'},'r').length,1);
  assert.deepEqual(svc.listAttachmentVersions({id:'reader'},first.id).map(x=>x.version),[2,1]);
  assert.equal(svc.getAttachment({id:'reader'},first.id).contentBuffer.toString(),'第一版');
  assert.equal(svc.getAttachment({id:'reader'},first.logicalId,{version:2}).contentBuffer.toString(),'第二版');
  assert.throws(()=>upload('覆盖',{expectedVersion:1}),e=>e.status===409);
  assert.equal(svc.listAttachments({id:'reader'},'r')[0].version,2);
  assert.throws(()=>svc.getAttachment({id:'outsider'},first.id),e=>e.status===403);
  assert.throws(()=>svc.listAttachmentVersions({id:'outsider'},first.id),e=>e.status===403);
  assert.throws(()=>svc.getAttachment({id:'reader'},first.id,{version:99}),e=>e.status===404);
});

test('上传校验、归档权限及审计失败均不产生新附件',t=>{
  const {db,svc,upload}=fixture(t);
  for(const name of ['../坏.md','坏\n.md','\u202e坏.md'])assert.throws(()=>upload('字',{name}),e=>e.status===400);
  assert.throws(()=>upload('字',{contentBuffer:Buffer.from([0xff])}),e=>e.status===400);
  assert.throws(()=>upload('字',{mime:'text/html'}),e=>e.status===400);
  assert.throws(()=>upload('字',{contentBuffer:Buffer.alloc(2*1024*1024+1)}),e=>e.status===413);
  assert.throws(()=>svc.uploadAttachment({id:'reader'},'r',{name:'设计.md',mime:'text/markdown',contentBuffer:Buffer.from('字')}),e=>e.status===403);
  db.exec("UPDATE requirements SET archived=1 WHERE id='r'");assert.throws(()=>upload('字'),e=>e.status===403);
  assert.equal(db.prepare('SELECT count(*) n FROM attachments').get().n,0);
  const failing=fixture(t,{audit:()=>{throw new Error('审计失败');}});assert.throws(()=>failing.upload('字'),/审计失败/);
  assert.equal(failing.db.prepare('SELECT count(*) n FROM attachments').get().n,0);
});

test('历史补录不会替换现用附件，旧式导入也自动进入版本链',t=>{
  const {db,svc,upload}=fixture(t);const current=upload('当前');
  db.prepare('INSERT INTO attachments(id,requirement_id,project_id,name,mime,content,historical,created_at) VALUES(?,?,?,?,?,?,1,?)').run('old','r','p','设计.md','text/markdown',Buffer.from('历史'),'2020-01-01');
  assert.equal(svc.listAttachments({id:'reader'},'r')[0].id,current.id);
  const next=upload('未来',{expectedVersion:1});assert.equal(next.version,3);
  assert.equal(svc.listAttachmentVersions({id:'reader'},current.id).length,3);
  assert.equal(svc.getAttachment({id:'reader'},'old').contentBuffer.toString(),'历史');
});
