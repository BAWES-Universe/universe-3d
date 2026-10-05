import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {createBuildContextFilter} from '../scripts/verify-container-files.mjs';

test('build context admits exactly the shared workshop source files and excludes private or unrelated module data',async()=>{
 const includes=createBuildContextFilter(await readFile(new URL('../.dockerignore',import.meta.url),'utf8'));
 for(const path of ['modules','modules/asset-workshop','modules/asset-workshop/model.js','modules/asset-workshop/geometry.js','modules/asset-workshop/view.js','src/main.js','server/furniture.mjs','scripts/build.mjs'])assert.equal(includes(path),true,path);
 for(const path of ['modules/other/index.js','modules/asset-workshop/secrets.js','modules/asset-workshop/.env','modules/asset-workshop/runtime.sqlite','modules/asset-workshop/private.key','modules/asset-workshop/README.md','modules/asset-workshop/evidence/result.json','modules/asset-workshop/node_modules/dependency.js','server/.env.preview','src/private.pem','public/assets/woka-1.png','node_modules/esbuild/index.js','evidence/output.json','.git/config'])assert.equal(includes(path),false,path);
 const files=await readdir(new URL('../modules/asset-workshop/',import.meta.url));
 assert.deepEqual(files.filter(file=>includes('modules/asset-workshop/'+file)).sort(),['geometry.js','model.js','view.js']);
});

test('both build and dependency-free runtime stages explicitly copy the shared workshop module',async()=>{
 for(const path of ['Dockerfile','deploy/preview/Dockerfile']){
  const dockerfile=await readFile(new URL('../'+path,import.meta.url),'utf8');
  for(const stage of dockerfile.split(/^FROM /m).slice(1))assert.match(stage,/^COPY modules\/asset-workshop \.\/modules\/asset-workshop$/m,path);
 }
});

test('bounded context verifier preserves last-rule and parent exclusions and rejects unsupported syntax',()=>{
 const includes=createBuildContextFilter('**\n!modules/\nmodules/*\n!modules/asset-workshop/\nmodules/asset-workshop/*\n!modules/asset-workshop/model.js\n**/*.key\n');
 assert.equal(includes('modules/asset-workshop/model.js'),true);
 assert.equal(includes('modules/other/nested/file.js'),false);
 assert.equal(includes('modules/asset-workshop/other.js'),false);
 for(const pattern of ['[ab]','foo?','../escape','/root','***','!'])assert.throws(()=>createBuildContextFilter(pattern),/Unsupported .dockerignore contract/);
});
