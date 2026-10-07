import {build} from 'esbuild';
import {cp,mkdir,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {extname,join,relative,resolve,sep} from 'node:path';
import {brotliCompressSync,gzipSync} from 'node:zlib';
await rm('dist',{recursive:true,force:true});
await mkdir('dist',{recursive:true}); await mkdir('evidence',{recursive:true});
await cp('public','dist',{recursive:true});
const result=await build({entryPoints:['src/main.js'],outdir:'dist',entryNames:'[name]',chunkNames:'chunks/[name]-[hash]',bundle:true,format:'esm',splitting:true,minify:true,target:'es2022',metafile:true});
// Admission must stay one allowed script even in setup-only mode. Bundle its
// shared destination validator without adding a runtime chunk dependency.
const signup=await build({entryPoints:['public/signup.js'],outfile:'dist/signup.js',bundle:true,format:'iife',minify:true,target:'es2022',metafile:true});
Object.assign(result.metafile.inputs,signup.metafile.inputs);Object.assign(result.metafile.outputs,signup.metafile.outputs);
await writeFile('evidence/build-metafile.json',JSON.stringify(result.metafile,null,2));

// Only bundler-generated paths in this explicitly content-hashed namespace
// qualify for immutable caching. Copied public files never qualify by name.
const outputs=new Set(Object.keys(result.metafile.outputs).map(name=>resolve(name)));
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const manifest={version:1,assets:{}};
const sizes={};
async function emitArtifacts(directory){
  for(const entry of await readdir(directory,{withFileTypes:true})){
    const filename=join(directory,entry.name);
    if(entry.isDirectory()){await emitArtifacts(filename);continue;}
    if(!entry.isFile()||entry.name.startsWith('.')||/\.(?:br|gz)$/.test(entry.name))continue;
    const bytes=await readFile(filename),name=relative(resolve('dist'),resolve(filename)).split(sep).join('/');
    const generated=outputs.has(resolve(filename));
    const asset={sha256:digest(bytes),bytes:bytes.length,immutable:generated&&name.startsWith('chunks/'),encodings:{}};
    if(/\.(?:html|js|css|json|svg|txt|xml|map)$/.test(extname(name))){
      const compressed={gzip:gzipSync(bytes),br:brotliCompressSync(bytes)};
      if(generated)sizes[filename]={raw:bytes.length,gzip:compressed.gzip.length,brotli:compressed.br.length};
      for(const [encoding,body] of Object.entries(compressed)){
        if(bytes.length<256||body.length>=bytes.length)continue;
        await writeFile(filename+(encoding==='br'?'.br':'.gz'),body);
        asset.encodings[encoding]={sha256:digest(body),bytes:body.length};
      }
    }
    manifest.assets[name]=asset;
  }
}
await emitArtifacts('dist');
// Write last: a partial build cannot describe unfinished compressed outputs.
await writeFile('dist/.static-assets.json',JSON.stringify(manifest));
await writeFile('evidence/bundle-sizes.json',JSON.stringify(sizes,null,2));console.log(sizes);
