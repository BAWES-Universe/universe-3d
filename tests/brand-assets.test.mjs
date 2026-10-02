import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {icon,ICON_NAMES} from '../src/universe-icons.js';
const asset=name=>new URL('../public/assets/'+name,import.meta.url);
test('full BAWES Universe logo bytes remain source-identical',async()=>{
 const hash=createHash('sha256').update(await readFile(asset('bawes-universe-logo.png'))).digest('hex');
 assert.equal(hash,'5e5b3f65d80bd38972cc56f94032848454784d76cb8be5cb31fe4b86d4242302');
});
test('source-backed glyphs retain geometry and decorative semantics',async()=>{
 const manifest=JSON.parse(await readFile(asset('icons/manifest.json'),'utf8'));
 assert.equal(manifest.length,ICON_NAMES.length);
 for(const {name,file} of manifest){
  const svg=(await readFile(asset('icons/'+file),'utf8')).trim();
  assert.match(svg,/viewBox="0 0 24 24"/);assert.match(svg,/aria-hidden="true"/);assert.match(svg,/focusable="false"/);
  assert.equal(icon(name).replace(/ class="u-icon " data-u-icon="[A-Za-z]+"/,''),svg);
 }
 assert.throws(()=>icon('Missing'),TypeError);
 assert.match(icon('Planet','x" onclick="oops'),/class="u-icon x&quot; onclick=&quot;oops"/);
});
test('native game fonts and Orbit body use explicit separate weight roles',async()=>{
 const style=await readFile(new URL('../public/style.css',import.meta.url),'utf8');
 assert.match(style,/@font-face\s*\{\s*font-family:\s*Space;[^}]*font-weight:\s*700;/);
 const tokens=await readFile(new URL('../public/universe-tokens.css',import.meta.url),'utf8');
 assert.match(tokens,/@font-face\s*\{\s*font-family:\s*Inter;[^}]*font-weight:\s*100 900;/);
 const fontHash=createHash('sha256').update(await readFile(asset('inter-variable.ttf'))).digest('hex');
 assert.equal(fontHash,'29160a80ff49ddcab2c97711247e08b1fab27a484a329ce8b813d820dc559031');
});
