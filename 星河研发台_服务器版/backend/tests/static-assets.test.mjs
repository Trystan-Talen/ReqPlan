import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import {PassThrough} from 'node:stream';
import {frontendHandler} from '../../deploy/dev.mjs';

const frontend=new URL('../../frontend/',import.meta.url);

async function fixture(t) {
  const handler=frontendHandler(()=>0);
  if(process.env.XINGHE_HTTP_SOCKET==='1') {
    const server=http.createServer(handler);
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    t.after(()=>new Promise(resolve=>server.close(resolve)));
    const origin=`http://127.0.0.1:${server.address().port}`;
    return async (url,method='GET')=>{
      const response=await fetch(origin+url,{method});
      return {status:response.status,headers:response.headers,body:Buffer.from(await response.arrayBuffer())};
    };
  }
  return (url,method='GET')=>new Promise((resolve,reject)=>{
    const req=new PassThrough();Object.assign(req,{url,method,headers:{}});
    const res=new PassThrough(),headers=new Headers(),chunks=[];
    res.writeHead=(status,values={})=>{res.statusCode=status;for(const [key,value] of Object.entries(values))headers.set(key,value);};
    res.on('data',chunk=>chunks.push(chunk));res.once('error',reject);
    res.once('end',()=>resolve({status:res.statusCode,headers,body:Buffer.concat(chunks)}));
    handler(req,res);req.end();
  });
}

test('摘要命名的小星图片按正确类型发送并长期缓存，HEAD 不发送图片正文',async t=>{
  const request=await fixture(t);
  const images=fs.readdirSync(new URL('assets/',frontend)).filter(name=>/^xiaoxing-indigo-\d+\.[a-f0-9]{12}\.webp$/.test(name));
  assert.ok(images.length>0,'缺少可缓存的品牌图片。');
  for(const name of images) {
    const route='/assets/'+name;
    const response=await request(route);
    assert.equal(response.status,200);
    assert.equal(response.headers.get('content-type'),'image/webp');
    assert.equal(response.headers.get('cache-control'),'public, max-age=31536000, immutable');
    assert.equal(response.headers.get('x-content-type-options'),'nosniff');
    assert.match(response.headers.get('content-security-policy'),/img-src 'self' data:/);
    assert.deepEqual(response.body,fs.readFileSync(new URL('assets/'+name,frontend)));
    const head=await request(route+'?preview=1','HEAD');
    assert.equal(head.status,200);
    assert.equal(head.headers.get('cache-control'),response.headers.get('cache-control'));
    assert.equal(head.headers.get('content-type'),'image/webp');
    assert.equal(head.body.length,0);
  }
});

test('页面、脚本、样式与原始无摘要图片继续使用原来的非缓存策略',async t=>{
  const request=await fixture(t);
  for(const route of ['/','/index.html','/ui-kit.js','/design/pages/dashboard.css','/assets/xiaoxing-indigo.png']) {
    const response=await request(route);
    assert.equal(response.status,200,route);
    assert.equal(response.headers.get('cache-control'),'no-store',route);
  }
});

test('缺失摘要资源返回不可长期缓存的 404，接口错误和页面回退不继承图片缓存',async t=>{
  const request=await fixture(t);
  for(const route of ['/assets/missing.0123456789ab.webp','/assets/missing.webp','/assets/']) {
    const response=await request(route);
    assert.equal(response.status,404,route);
    assert.equal(response.headers.get('cache-control'),'no-store',route);
    assert.equal(response.body.length,0,route);
  }
  const api=await request('/api/health');
  assert.equal(api.status,503);
  assert.equal(api.headers.get('cache-control'),'no-store');
  const fallback=await request('/missing.0123456789ab.webp');
  assert.equal(fallback.status,200);
  assert.equal(fallback.headers.get('cache-control'),'no-store');
  assert.match(fallback.headers.get('content-type'),/^text\/html/);
});
