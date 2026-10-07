import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {gunzipSync,brotliDecompressSync} from 'node:zlib';

test('the real build emits verified smaller artifacts and marks only generated hashed chunks immutable',async t=>{
  const root=await mkdtemp(join(tmpdir(),'universe-static-build-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  await mkdir(join(root,'src'),{recursive:true});
  await mkdir(join(root,'public/chunks'),{recursive:true});
  await writeFile(join(root,'src/main.js'),"import './main.css'; globalThis.load=()=>import('./lazy.js');");
  await writeFile(join(root,'src/main.css'),'body{color:green}');
  await writeFile(join(root,'src/lazy.js'),`export const payload=${JSON.stringify('compressible fixture '.repeat(1000))};`);
  await writeFile(join(root,'src/signup-helper.js'),'export const destination="/";');
  await writeFile(join(root,'public/signup.js'),"import {destination} from '../src/signup-helper.js';globalThis.signupDestination=destination;");
  await writeFile(join(root,'public/index.html'),'<html>Fixture</html>');
  await writeFile(join(root,'public/style.css'),'body { color: green; }\n'.repeat(1000));
  await writeFile(join(root,'public/chunks/impostor-ABCDEFGH.js'),'console.log("mutable copied asset");');
  await writeFile(join(root,'public/image.png'),Buffer.from([0,1,2,3]));
  await promisify(execFile)(process.execPath,[resolve('scripts/build.mjs')],{cwd:root});
  const manifest=JSON.parse(await readFile(join(root,'dist/.static-assets.json'),'utf8'));
  assert.equal(manifest.version,1);
  let compressedCount=0,immutableCount=0;
  for(const [name,asset] of Object.entries(manifest.assets)){
    const source=await readFile(join(root,'dist',name));
    assert.equal(asset.bytes,source.length,name);
    assert.equal(asset.sha256,createHash('sha256').update(source).digest('hex'),name);
    if(asset.immutable){immutableCount++;assert.match(name,/^chunks\/lazy-[A-Z0-9]+\.js$/);}
    for(const [encoding,record] of Object.entries(asset.encodings)){
      const body=await readFile(join(root,'dist',name)+(encoding==='br'?'.br':'.gz'));
      assert.equal(record.bytes,body.length);assert(body.length<source.length);
      assert.equal(record.sha256,createHash('sha256').update(body).digest('hex'));
      assert.deepEqual(encoding==='br'?brotliDecompressSync(body):gunzipSync(body),source);compressedCount++;
    }
  }
  assert.equal(immutableCount,1);assert(compressedCount>=4);
  for(const name of ['main.js','signup.js','main.css','index.html','style.css','chunks/impostor-ABCDEFGH.js','image.png'])assert.equal(manifest.assets[name].immutable,false,name);
  assert.deepEqual(manifest.assets['image.png'].encodings,{});
  const signup=await readFile(join(root,'dist/signup.js'),'utf8');assert.doesNotMatch(signup,/\bimport\b|signup-helper|chunks\//);assert.match(signup,/signupDestination/);
  const sizes=JSON.parse(await readFile(join(root,'evidence/bundle-sizes.json'),'utf8'));
  assert(sizes['dist/main.js'].raw>0);assert(Object.keys(sizes).some(name=>name.startsWith('dist/chunks/lazy-')));
});
