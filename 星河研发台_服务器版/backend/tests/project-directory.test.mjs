import test from 'node:test';
import assert from 'node:assert/strict';
import {createProjectLayoutPreferences, renderProjectTable} from '../../frontend/project-directory.js';

test('目录显示偏好按账号持久保存，未知值与不可用存储安全回退', () => {
  const saved = new Map();
  const storage = {getItem:key=>saved.get(key),setItem:(key,value)=>saved.set(key,value)};
  const first = createProjectLayoutPreferences(()=>storage);
  assert.equal(first.get('a'),'card');
  assert.equal(first.set('a','list'),true);
  assert.equal(first.get('b'),'card');
  assert.equal(createProjectLayoutPreferences(()=>storage).get('a'),'list');
  assert.equal(first.set('a','unexpected'),false);
  assert.equal(first.get('a'),'list');
  assert.deepEqual([...saved.values()],['list']);
  assert.equal(createProjectLayoutPreferences(()=>({getItem:()=> 'unexpected'})).get('a'),'card');
  const denied = createProjectLayoutPreferences(()=>{throw new Error('storage unavailable');});
  assert.equal(denied.get('a'),'card');
  assert.equal(denied.set('a','list'),true);
  assert.equal(denied.get('a'),'list');
  assert.equal(denied.get('b'),'card');
  assert.equal(denied.set('', 'list'),false);
});

test('目录表格转义项目、成员、角色与地址；无任务与全终止不显示虚构百分比', () => {
  const attack = '"><img src=x onerror=alert(1)>';
  const projects = [{id:'empty',name:attack,description:attack,ownerId:'u',targetDate:attack},{id:'closed',name:'已终止任务项目',status:'进行中'}];
  const html = renderProjectTable(projects, {
    summaryOf:project=>({reqs:[],tasks:project.id==='closed'?[{}]:[],eligible:[],completed:0,percent:0}),
    nameOf:()=>attack,roleOf:()=>attack,projectPath:()=>`#/p/${attack}/overview`
  });
  assert.doesNotMatch(html, /<img|0%|<button|data-action="edit/);
  assert.match(html, /&quot;&gt;&lt;img/);
  assert.match(html, /暂无任务/);
  assert.match(html, /任务均已终止/);
  assert.equal((html.match(/<a /g)||[]).length,2);
  assert.match(html, /role="region" aria-label="项目目录表格，可横向滚动"/);
});
