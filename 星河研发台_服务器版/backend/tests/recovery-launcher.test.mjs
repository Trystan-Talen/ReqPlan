import test from 'node:test';
import assert from 'node:assert/strict';
import {readRecoveryTarget,verifyRecoveryTarget,recoverAdmin,validateRecoveryUrl,parseRecoveryArguments} from '../../deploy/admin-recovery.mjs';

test('恢复入口读取实际运行端口及数据库，拒绝不安全地址和不完整状态',()=>{
  const state={url:'http://127.0.0.1:51617',databasePath:'/private/tmp/custom.sqlite',instanceId:'running-instance'};
  const target=readRecoveryTarget({env:{},readState:()=>state});
  assert.equal(target.url,state.url);assert.equal(target.databasePath,state.databasePath);assert.equal(target.instanceId,state.instanceId);
  assert.equal(validateRecoveryUrl('https://workspace.example'),'https://workspace.example');
  for(const url of ['http://external.example','https://user:secret@workspace.example','http://127.0.0.1:51617/#token=secret','http://127.0.0.1:51617/path'])assert.throws(()=>validateRecoveryUrl(url));
  assert.throws(()=>readRecoveryTarget({env:{},readState:()=>({...state,instanceId:''})}));
  assert.throws(()=>readRecoveryTarget({env:{},options:{url:'https://workspace.example'}}));
});

test('仅验证同实例健康状态，不向校验请求发送恢复令牌，失败不撤销任何账号',async()=>{
  const target={url:'http://127.0.0.1:51617',instanceId:'expected'};
  let called;
  await verifyRecoveryTarget(target,async(url,options)=>{called={url,options};return{ok:true,json:async()=>({status:'ok',instanceId:'expected'})};});
  assert.equal(called.url,target.url+'/api/health');assert.equal(called.options.redirect,'error');
  let issued=false,opened=false;
  await assert.rejects(recoverAdmin({resolveTarget:()=>target,verifyTarget:value=>verifyRecoveryTarget(value,async()=>({ok:true,json:async()=>({status:'ok',instanceId:'other'})})),issue:()=>{issued=true;},openUrl:async()=>{opened=true;}}));
  assert.equal(issued,false);assert.equal(opened,false);
  await assert.rejects(verifyRecoveryTarget(target,async()=>{throw new Error('offline');}));
});

test('恢复入口先验证运行服务再签发，令牌只交网页片段且不在正常日志中',async()=>{
  const steps=[],logs=[];let opened;
  const token='test-only-token-'.repeat(3);
  const result=await recoverAdmin({resolveTarget:()=>({url:'http://127.0.0.1:51617'}),verifyTarget:async()=>steps.push('verify'),issue:()=>{steps.push('issue');return{username:'manager',token,expiresAt:'test-expiry'};},openUrl:async url=>{steps.push('open');opened=url;},logger:{info:value=>logs.push(value)}});
  assert.deepEqual(steps,['verify','issue','open']);assert.deepEqual(result,{username:'manager',expiresAt:'test-expiry'});
  const url=new URL(opened),fragment=new URLSearchParams(url.hash.slice(1));
  assert.equal(url.search,'');assert.equal(fragment.get('activate'),token);assert.equal(fragment.get('purpose'),'admin-reset');assert.equal(fragment.get('username'),'manager');
  assert.equal(logs.join('\n').includes(token),false);
});

test('仅显式要求打印或打开浏览器失败时展示一次性链接供本人恢复',async()=>{
  for(const printLink of [true,false]){
    const logs=[];let opened=false;
    await recoverAdmin({options:{printLink},resolveTarget:()=>({url:'https://workspace.example'}),verifyTarget:async()=>{},issue:()=>({username:'manager',token:'private-one-time-token',expiresAt:'test'}),openUrl:async()=>{opened=true;throw new Error('no browser');},logger:{info:value=>logs.push(value)}});
    assert.equal(opened,!printLink);assert.ok(logs.some(line=>line.includes('#activate=private-one-time-token')));
  }
});

test('命令行明确选择账号与站点，拒绝密码参数和重复或缺失参数',()=>{
  assert.deepEqual(parseRecoveryArguments(['--db','/data/app.sqlite','--url','https://workspace.example','--username','manager','--print-link']),{db:'/data/app.sqlite',url:'https://workspace.example',username:'manager',printLink:true});
  for(const args of [['--password','anything'],['--username'],['--print-link','--print-link'],['--url','--db'],['--db','one','--db','two']])assert.throws(()=>parseRecoveryArguments(args));
});
