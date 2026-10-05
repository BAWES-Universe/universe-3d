/** Validate both Dockerfile COPY boundaries, without claiming a Docker run. */
import {cp,mkdir,mkdtemp,readFile,realpath,rm,symlink,writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {tmpdir} from 'node:os';
import {dirname,join,relative,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

/** Deliberately bounded to this repository's .dockerignore grammar. Patterns
 * apply to a path and its parents, with the last matching rule winning. New
 * syntax requires an explicit verifier change instead of silently false proof. */
export function createBuildContextFilter(text){
 const rules=text.split(/\r?\n/).map(line=>line.trim()).filter(line=>line&&!line.startsWith('#')).map(line=>{
  const include=line.startsWith('!'),pattern=(include?line.slice(1):line).replace(/\/$/,'');
  if(!pattern||!/^[A-Za-z0-9_.*\/-]+$/.test(pattern)||pattern.startsWith('/')||pattern.split('/').some(part=>part==='..')||pattern.includes('***'))throw Error('Unsupported .dockerignore contract: '+line);
  // Docker wildcards include dotfiles; shell-style glob helpers often do not.
  const expression=pattern.split(/(\*\*\/|\*\*|\*)/).map(part=>part==='**/'?'(?:.*/)?':part==='**'?'.*':part==='*'?'[^/]*':part.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('');
  return{include,match:new RegExp('^'+expression+'$')};
 });
 return path=>{
  if(path==='')return true;
  const parts=path.split('/'),parents=parts.map((_,index)=>parts.slice(0,index+1).join('/'));
  let included=true;
  for(const rule of rules)if(parents.some(parent=>rule.match.test(parent)))included=rule.include;
  return included;
 };
}

function run(command,args,cwd){return new Promise((yes,no)=>{
 const p=spawn(command,args,{cwd,env:process.env,stdio:['ignore','pipe','pipe']});let output='';
 const timer=setTimeout(()=>{p.kill('SIGTERM');no(Error('Package verification timed out: '+output));},120000);timer.unref();
 p.stdout.on('data',b=>output+=b);p.stderr.on('data',b=>output+=b);
 p.once('error',error=>{clearTimeout(timer);no(error);});
 p.once('exit',code=>{clearTimeout(timer);code===0?yes(output):no(Error(output));});
});}

async function verifyDockerfile(root,scratch,dockerfile,contextIncludes){
 const stages={build:join(scratch,'build'),runtime:join(scratch,'runtime')},copies=[];
 for(const path of Object.values(stages))await mkdir(path,{recursive:true});
 let stage,built=false;
 for(const raw of (await readFile(join(root,dockerfile),'utf8')).split('\n')){
  const from=raw.match(/^FROM\s+\S+\s+AS\s+(build|runtime)$/i);if(from){stage=from[1].toLowerCase();continue;}
  if(raw==='RUN npm run build'&&stage==='build'){
   await symlink(await realpath(join(root,'node_modules')),join(stages.build,'node_modules'),'dir');
   await run(process.execPath,['scripts/build.mjs'],stages.build);built=true;continue;
  }
  if(!raw.startsWith('COPY '))continue;
  const fields=raw.slice(5).trim().split(/\s+/),fromBuild=fields[0]==='--from=build';if(fromBuild)fields.shift();
  if(!stage||fields.some(s=>s.includes('*')||s.includes('..')||s.startsWith('--'))||fields.length<2)throw Error('Unsupported COPY contract: '+raw);
  if(fromBuild&&!built)throw Error('Build output copied before build: '+dockerfile);
  const destination=fields.pop(),base=fromBuild?stages.build:root;
  for(const source of fields){
   const sourceRelative=fromBuild?source.replace(/^\/app\//,''):source;
   if(!fromBuild&&!contextIncludes(sourceRelative))throw Error('COPY source excluded by .dockerignore: '+source);
   const destinationPath=join(stages[stage],destination.replace(/^\.\//,''),fields.length>1?source.split('/').at(-1):'');
   await mkdir(dirname(destinationPath),{recursive:true});
   await cp(join(base,sourceRelative),destinationPath,{recursive:true,...(fromBuild?{}:{filter:path=>contextIncludes(relative(root,path).split('\\').join('/'))})});
   copies.push({stage,source,destination});
  }
 }
 const runtimeOutput=await run(process.execPath,[join(root,'scripts/verify-package.mjs'),stages.runtime],stages.runtime);
 return{dockerfile,copies,runtimeOutput:JSON.parse(runtimeOutput)};
}

export async function verifyContainerFiles(root=resolve('.')){
 const scratch=await mkdtemp(join(tmpdir(),'universe-container-files-'));
 try{
  const contextIncludes=createBuildContextFilter(await readFile(join(root,'.dockerignore'),'utf8')),packages=[];
  for(const [index,dockerfile] of ['Dockerfile','deploy/preview/Dockerfile'].entries())packages.push(await verifyDockerfile(root,join(scratch,String(index)),dockerfile,contextIncludes));
  const report={checkedAt:new Date().toISOString(),status:'passed',packages,limits:[
   'Copies declared source/build files from both Dockerfiles through the supported .dockerignore subset; build dependencies are linked from the installed lockfile environment',
   'Each runtime has no node_modules and starts with a temporary local-mode database',
   'No Docker daemon, image build/run, container UID, network, TLS proxy or public-mode deployment was exercised'
  ]};
  await mkdir(join(root,'evidence'),{recursive:true});await writeFile(join(root,'evidence/container-files.json'),JSON.stringify(report,null,2));
  return report;
 }finally{await rm(scratch,{recursive:true,force:true});}
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(await verifyContainerFiles(),null,2));
