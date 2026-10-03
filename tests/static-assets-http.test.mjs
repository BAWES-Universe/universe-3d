import test from 'node:test';
import assert from 'node:assert/strict';
import {request} from 'node:http';
import {mkdtemp,mkdir,writeFile,readFile,rm,stat,utimes,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {gzipSync,brotliCompressSync,gunzipSync,brotliDecompressSync} from 'node:zlib';
import {createGameServer} from '../server/app.mjs';

const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'universe-static-http-')),dist=join(root,'dist');
  await mkdir(join(dist,'chunks'),{recursive:true});
  const sources={
    'index.html':Buffer.from('<html>Static fixture</html>\n'.repeat(100)),
    'main.js':Buffer.from('globalThis.fixture="static delivery";\n'.repeat(100)),
    'style.css':Buffer.from('body{color:green}\n'.repeat(100)),
    'chunks/lazy-ABCDEFGH.js':Buffer.from('export const fixture="lazy";\n'.repeat(100)),
    'chunks/copied-ABCDEFGH.js':Buffer.from('globalThis.mutable=true;\n'.repeat(100)),
    'image.png':Buffer.from([0,1,2,3,4,5])
  };
  const manifest={version:1,assets:{}};
  for(const [name,bytes] of Object.entries(sources)){
    await writeFile(join(dist,name),bytes);
    const record={sha256:digest(bytes),bytes:bytes.length,immutable:name==='chunks/lazy-ABCDEFGH.js',encodings:{}};
    if(!name.endsWith('.png'))for(const [encoding,body] of Object.entries({gzip:gzipSync(bytes),br:brotliCompressSync(bytes)})){
      await writeFile(join(dist,name)+(encoding==='br'?'.br':'.gz'),body);
      record.encodings[encoding]={sha256:digest(body),bytes:body.length};
    }
    manifest.assets[name]=record;
  }
  const saveManifest=()=>writeFile(join(dist,'.static-assets.json'),JSON.stringify(manifest));await saveManifest();
  const app=createGameServer({dist});const {port}=await app.listen(0);
  t.after(async()=>{await app.close();await rm(root,{recursive:true,force:true});});
  const get=(path='/main.js',{headers={},method='GET',body,firstChunk=false}={})=>new Promise((yes,no)=>{
    const req=request({hostname:'127.0.0.1',port,path,method,headers},res=>{
      const chunks=[];
      const finish=()=>yes({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks)});
      res.on('data',chunk=>{chunks.push(chunk);if(firstChunk){finish();req.destroy();}});
      res.on('end',finish);res.on('error',error=>{if(!firstChunk)no(error);});
    });req.on('error',no);req.end(body);
  });
  return {root,dist,sources,manifest,saveManifest,get};
}
const encoding=(value,extra={})=>({headers:{'accept-encoding':value,...extra}});

test('actual HTTP serves validated Brotli/gzip bytes and representation-specific metadata',async t=>{
  const f=await fixture(t);const raw=await f.get();
  assert.equal(raw.status,200);assert.deepEqual(raw.body,f.sources['main.js']);
  assert.equal(raw.headers['content-encoding'],undefined);assert.equal(raw.headers['cache-control'],'no-cache');
  for(const value of ['br, gzip','gzip']){
    const r=await f.get('/main.js',encoding(value)),coding=value.startsWith('br')?'br':'gzip';
    assert.equal(r.status,200);assert.equal(r.headers['content-encoding'],coding);
    assert.equal(r.headers.vary,'Accept-Encoding');assert.equal(Number(r.headers['content-length']),r.body.length);
    assert(r.body.length<raw.body.length);assert.notEqual(r.headers.etag,raw.headers.etag);
    assert.deepEqual(coding==='br'?brotliDecompressSync(r.body):gunzipSync(r.body),raw.body);
    assert.equal(r.headers['content-type'],'text/javascript; charset=utf-8');
    assert.equal(r.headers['x-content-type-options'],'nosniff');assert(r.headers['content-security-policy'].includes("frame-ancestors 'none'"));
  }
  const binary=await f.get('/image.png',encoding('br, gzip'));assert.deepEqual(binary.body,f.sources['image.png']);assert.equal(binary.headers['content-encoding'],undefined);
});

test('negotiation handles exclusions, quality, wildcards, identity and malformed input',async t=>{
  const f=await fixture(t);
  for(const [value,expected] of [
    ['',undefined],['deflate',undefined],['br, gzip','br'],['BR; Q=1, GZIP;q=0.8','br'],
    ['br;q=0.1, gzip;q=0.9','gzip'],['br;q=0, gzip;q=0.4','gzip'],['br;q=0, gzip;q=0',undefined],
    ['br;q=0.4, identity;q=0.7',undefined],['br;q=0.8, identity;q=0.2','br'],
    ['*','br'],['br;q=0, *;q=0.5','gzip'],['*;q=0, identity;q=1',undefined],
    ['br;q=bogus, gzip;q=0.5','gzip'],['br;q=1.1, gzip;q=0.5','gzip'],
    ['br;q=-1',undefined],['br;q=.5',undefined],['br;q=0.1234',undefined],
    ['br;q=0;q=1, gzip','gzip'],['br;invalid=1, gzip','gzip'],['br;q=0, br;q=1, gzip','gzip'],
    ['br;q=0.001, gzip;q=0.002','gzip']
  ]){
    const r=await f.get('/main.js',encoding(value));assert.equal(r.status,200,value);assert.equal(r.headers['content-encoding'],expected,value);
  }
  for(const value of ['*;q=0','br;q=0,gzip;q=0,identity;q=0','deflate,identity;q=0']){
    const r=await f.get('/main.js',encoding(value));assert.equal(r.status,406,value);assert.equal(r.body.length,0);assert.equal(r.headers['cache-control'],'no-store');assert.equal(r.headers.vary,'Accept-Encoding');
  }
  const binary=await f.get('/image.png',encoding('br,identity;q=0'));assert.equal(binary.status,406);
});

test('ETag revalidation has no response body and evaluates the selected representation',async t=>{
  const f=await fixture(t),raw=await f.get(),br=await f.get('/main.js',encoding('br'));
  for(const tag of [br.headers.etag,'W/'+br.headers.etag,'"unrelated,tag", W/'+br.headers.etag,'*']){
    const r=await f.get('/main.js',encoding('br',{'if-none-match':tag}));
    assert.equal(r.status,304,tag);assert.equal(r.body.length,0);assert.equal(r.headers['content-length'],undefined);
    for(const name of ['etag','vary','cache-control','content-encoding'])assert.equal(r.headers[name],br.headers[name]);
  }
  for(const tag of [raw.headers.etag,'garbage, '+br.headers.etag,br.headers.etag+', garbage','*garbage','']){
    const r=await f.get('/main.js',encoding('br',{'if-none-match':tag}));assert.equal(r.status,200,tag);
  }
  const precondition=await f.get('/main.js',encoding('br',{'if-match':raw.headers.etag,'if-none-match':'*'}));assert.equal(precondition.status,412);assert.equal(precondition.headers['content-encoding'],undefined);
  assert.equal((await f.get('/main.js',encoding('br',{'if-match':'W/'+br.headers.etag}))).status,412);
  assert.equal((await f.get('/main.js',encoding('br',{'if-match':br.headers.etag}))).status,200);
  assert.equal((await f.get('/main.js',encoding('br',{'if-match':'*'}))).status,200);
  const date=await f.get('/main.js',encoding('br',{'if-modified-since':'Wed, 01 Jan 2099 00:00:00 GMT'}));assert.equal(date.status,200);assert.equal(date.headers['last-modified'],undefined);
});

test('HEAD mirrors GET without bytes; ranges never mix compressed and identity offsets',async t=>{
  const f=await fixture(t),get=await f.get('/main.js',encoding('br'));
  const head=await f.get('/main.js',{...encoding('br'),method:'HEAD'});
  assert.equal(head.status,200);assert.equal(head.body.length,0);
  for(const name of ['content-length','content-type','content-encoding','etag','cache-control','vary'])assert.equal(head.headers[name],get.headers[name]);
  const head304=await f.get('/main.js',{...encoding('br',{'if-none-match':get.headers.etag}),method:'HEAD'});assert.equal(head304.status,304);assert.equal(head304.body.length,0);
  for(const range of ['bytes=0-10','bytes=999999999-','bytes=0-1,10-20','nonsense']){
    const r=await f.get('/main.js',encoding('br',{range,'if-range':get.headers.etag}));assert.equal(r.status,200);assert.deepEqual(r.body,get.body);assert.equal(r.headers['content-range'],undefined);assert.equal(r.headers['accept-ranges'],'none');
  }
  assert.equal((await f.get('/main.js',encoding('br',{range:'bytes=0-10','if-none-match':get.headers.etag}))).status,304);
});

test('only verified generated chunks are immutable; entry and copied assets stay fresh',async t=>{
  const f=await fixture(t);
  const chunk=await f.get('/chunks/lazy-ABCDEFGH.js',encoding('br'));assert.equal(chunk.headers['cache-control'],'public, max-age=31536000, immutable');
  for(const name of ['/','/place/fixture','/main.js','/style.css','/chunks/copied-ABCDEFGH.js','/image.png']){
    const r=await f.get(name,encoding('br'));assert.equal(r.status,200,name);assert.equal(r.headers['cache-control'],'no-cache',name);assert(r.headers.etag);
  }
  const before=await f.get('/main.js',encoding('br'));
  const path=join(f.dist,'main.js'),previous=await stat(path);
  const changed=Buffer.from(f.sources['main.js']);changed[0]=changed[0]===97?98:97;
  await writeFile(path,changed);await utimes(path,previous.atime,previous.mtime);
  const after=await f.get('/main.js',encoding('br',{'if-none-match':before.headers.etag}));
  assert.equal(after.status,200);assert.equal(after.headers['content-encoding'],undefined);assert.notEqual(after.headers.etag,before.headers.etag);assert.deepEqual(after.body,changed);
  await writeFile(join(f.dist,'chunks/lazy-ABCDEFGH.js'),'changed chunk');
  const changedChunk=await f.get('/chunks/lazy-ABCDEFGH.js',encoding('br'));assert.equal(changedChunk.headers['cache-control'],'no-cache');assert.equal(changedChunk.headers['content-encoding'],undefined);
});

test('stale, missing and malformed compressed artifacts fall back safely',async t=>{
  const f=await fixture(t),path=join(f.dist,'main.js.br');
  const body=await readFile(path),previous=await stat(path);body[0]^=1;
  await writeFile(path,body);await utimes(path,previous.atime,previous.mtime);
  const gzip=await f.get('/main.js',encoding('br,gzip'));assert.equal(gzip.headers['content-encoding'],'gzip');assert.deepEqual(gunzipSync(gzip.body),f.sources['main.js']);
  await rm(join(f.dist,'main.js.gz'));
  const raw=await f.get('/main.js',encoding('br,gzip'));assert.equal(raw.headers['content-encoding'],undefined);assert.deepEqual(raw.body,f.sources['main.js']);
  assert.equal((await f.get('/main.js',encoding('br,gzip,identity;q=0'))).status,406);
  for(const text of ['{bad json','null',JSON.stringify({...f.manifest,version:2})]){
    await writeFile(join(f.dist,'.static-assets.json'),text);
    const r=await f.get('/style.css',encoding('br,gzip'));assert.equal(r.headers['content-encoding'],undefined);assert.deepEqual(r.body,f.sources['style.css']);
  }
  await rm(join(f.dist,'.static-assets.json'));
  const noManifest=await f.get('/main.js');assert.equal((await f.get('/main.js',{headers:{'if-none-match':noManifest.headers.etag}})).status,304);
});

test('static method, path containment and hidden artifact restrictions survive extraction',async t=>{
  const f=await fixture(t);
  await writeFile(join(f.root,'outside.txt'),'private fixture outside dist');
  await symlink(join(f.root,'outside.txt'),join(f.dist,'escape.txt'));
  await rm(join(f.dist,'style.css.br'));
  await symlink(join(f.root,'outside.txt'),join(f.dist,'style.css.br'));
  for(const path of ['/.static-assets.json','/%2estatic-assets.json','/main.js.br','/main.js.gz','/missing.js','/%2e%2e%2foutside.txt','/a%2f..%2fmain.js','/%2f..%2foutside.txt','/bad%00name','/%5c..%5coutside.txt','/%ZZ','/escape.txt']){
    const r=await f.get(path,encoding('br,gzip'));assert.equal(r.status,404,path);assert.equal(r.headers['cache-control'],'no-store');assert.equal(r.headers['content-encoding'],undefined);
  }
  const badSidecar=await f.get('/style.css',encoding('br,gzip'));assert.equal(badSidecar.headers['content-encoding'],'gzip');
  const method=await f.get('/main.js',{method:'POST'});assert.equal(method.status,405);assert.equal(method.headers.allow,'GET, HEAD');
  const wrongHost=await f.get('/main.js',{headers:{host:'evil.test','accept-encoding':'br'}});assert.equal(wrongHost.status,403);assert.equal(wrongHost.headers['content-encoding'],undefined);
});

test('authenticated JSON and SSE retain no-store and never enter static negotiation',async t=>{
  const f=await fixture(t);
  const created=await f.get('/api/session',{method:'POST',headers:{'content-type':'application/json','accept-encoding':'br,gzip'},body:JSON.stringify({name:'Static isolation fixture'})});
  assert.equal(created.status,201);const cookie=created.headers['set-cookie'][0].split(';')[0];
  for(const path of ['/api/session','/api/health','/api/unknown']){
    const r=await f.get(path,{headers:{cookie,'accept-encoding':'br,gzip,identity;q=0','if-none-match':'*'}});
    assert.notEqual(r.status,304);assert.notEqual(r.status,406);assert.equal(r.headers['cache-control'],'no-store');assert.equal(r.headers.etag,undefined);assert.equal(r.headers['content-encoding'],undefined);
  }
  const sse=await f.get('/api/events',{headers:{cookie,'accept-encoding':'br,gzip,identity;q=0','if-none-match':'*'},firstChunk:true});
  assert.equal(sse.status,200);assert.equal(sse.headers['content-type'],'text/event-stream');assert.equal(sse.headers['cache-control'],'no-store');assert.equal(sse.headers['content-encoding'],undefined);assert.equal(sse.headers.etag,undefined);assert(sse.body.length>0);
});
