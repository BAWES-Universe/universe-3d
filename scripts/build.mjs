import {build} from 'esbuild';
import {cp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {brotliCompressSync,gzipSync} from 'node:zlib';
await rm('dist',{recursive:true,force:true});
await mkdir('dist',{recursive:true}); await mkdir('evidence',{recursive:true});
await cp('public','dist',{recursive:true});
const result=await build({entryPoints:['src/main.js'],outdir:'dist',bundle:true,format:'esm',splitting:true,minify:true,target:'es2022',metafile:true});
await writeFile('evidence/build-metafile.json',JSON.stringify(result.metafile,null,2));
let sizes={};for(const name of Object.keys(result.metafile.outputs)){const b=await readFile(name);sizes[name]={raw:b.length,gzip:gzipSync(b).length,brotli:brotliCompressSync(b).length};}
await writeFile('evidence/bundle-sizes.json',JSON.stringify(sizes,null,2));console.log(sizes);
