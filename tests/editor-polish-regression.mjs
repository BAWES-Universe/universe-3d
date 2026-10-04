/** Reuse pinned upstream suites without changing their files or output namespaces. */
import {readFile,writeFile,mkdir,unlink} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
const suites=process.argv.slice(2);
if(!suites.length)throw Error('Pass repository test filenames');
await mkdir('evidence/editor-polish-regression',{recursive:true});
const results=JSON.parse(await readFile('evidence/editor-polish-regression/results.json','utf8').catch(()=>'[]'));
for(const suite of suites){
 if(!/^[a-z0-9.-]+\.mjs$/.test(suite)||suite.startsWith('editor-polish-'))throw Error('Invalid suite');
 const source=await readFile(new URL('./'+suite,import.meta.url),'utf8');
 const path=new URL('./editor-polish-generated.mjs',import.meta.url);
 // Keep relative imports and fixture URLs intact; redirect only evidence output.
 await writeFile(path,source.replaceAll('evidence/','evidence/editor-polish-regression/').replaceAll("mkdir('evidence'","mkdir('evidence/editor-polish-regression'"));
 const started=Date.now();console.log('RUN',suite);
 const exitCode=await new Promise(resolve=>{const child=spawn(process.execPath,[path.pathname],{stdio:'inherit',env:process.env});child.on('exit',resolve);});
 const hash=async path=>createHash('sha256').update(await readFile(path)).digest('hex');
 results.push({suite,exitCode,durationMs:Date.now()-started,editor:await hash('src/editor.js'),css:await hash('src/editor.css'),bundle:await hash('dist/main.js')});await unlink(path);
 await writeFile('evidence/editor-polish-regression/results.json',JSON.stringify(results,null,2));
 if(exitCode){process.exitCode=1;break;}
}
