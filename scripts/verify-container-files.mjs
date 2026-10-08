/** Validate the Dockerfile's COPY boundaries without claiming a Docker run. */
import {cp,mkdir,mkdtemp,readFile,realpath,rm,symlink,writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';

const recipe=process.argv[2]||'Dockerfile';
if(!['Dockerfile','deploy/on-dev/Dockerfile'].includes(recipe))throw Error('Unsupported container recipe');
const root=resolve('.'),scratch=await mkdtemp(join(tmpdir(),'universe-container-files-'));
const stages={build:join(scratch,'build'),runtime:join(scratch,'runtime')};
const copies=[];
function run(command,args,cwd){return new Promise((yes,no)=>{const p=spawn(command,args,{cwd,env:process.env,stdio:['ignore','pipe','pipe']});let output='';p.stdout.on('data',b=>output+=b);p.stderr.on('data',b=>output+=b);p.once('error',no);p.once('exit',code=>code===0?yes(output):no(Error(output)));});}
try{
 for(const path of Object.values(stages))await mkdir(path,{recursive:true});
 let stage;
 for(const raw of (await readFile(join(root,recipe),'utf8')).split('\n')){
  const from=raw.match(/^FROM\s+\S+\s+AS\s+(build|runtime)$/i);if(from){stage=from[1].toLowerCase();continue;}
  if(!raw.startsWith('COPY '))continue;
  const fields=raw.slice(5).trim().split(/\s+/),fromBuild=fields[0]==='--from=build';if(fromBuild)fields.shift();
  if(!stage||fields.some(s=>s.includes('*')||s.includes('..'))||fields.length<2)throw Error('Unsupported COPY contract: '+raw);
  const destination=fields.pop(),base=fromBuild?stages.build:root;
  for(const source of fields){
   const relative=fromBuild?source.replace(/^\/app\//,''):source;
   const destinationPath=join(stages[stage],destination.replace(/^\.\//,''),fields.length>1?source.split('/').at(-1):'');
   await mkdir(dirname(destinationPath),{recursive:true});await cp(join(base,relative),destinationPath,{recursive:true});copies.push({stage,source,destination});
  }
  // Build output must exist before runtime's COPY --from.
  if(stage==='build'&&raw.includes('scripts/build.mjs')){
   await symlink(await realpath(join(root,'node_modules')),join(stages.build,'node_modules'),'dir');
   await run(process.execPath,['scripts/build.mjs'],stages.build);
  }
 }
 const runtimeOutput=await run(process.execPath,[join(root,'scripts/verify-package.mjs'),stages.runtime],stages.runtime);
 const report={checkedAt:new Date().toISOString(),status:'passed',recipe,copies,runtimeOutput:JSON.parse(runtimeOutput),limits:['Copies exactly the declared source/build files; build dependencies are linked from the installed lockfile environment','Runtime has no node_modules and uses a temporary local-mode database','No Docker daemon, image build/run, container UID, network, TLS proxy or public-mode deployment was exercised']};
 await mkdir(join(root,'evidence'),{recursive:true});await writeFile(join(root,recipe==='Dockerfile'?'evidence/container-files.json':'evidence/on-dev-container-files.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{await rm(scratch,{recursive:true,force:true});}
