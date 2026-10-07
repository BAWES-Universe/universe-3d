import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {signupLink,signupDestination,signupStartsWithSignin,signupViewLink} from '../src/signup-navigation.js';
const origin='https://universe.example.test';
test('onboarding carries only validated room, named arrival and existing invitation through an HTTP-free fragment',()=>{
 const query='room=studio&entry=welcome&invite=Existing_invite-1';
 const link=signupLink(origin+'/?'+query+'&email=private%40example.test&next=https://evil.test#other');
 assert.equal(link,'/signup.html#'+query);assert.equal(new URL(link,origin).search,'');
 assert.equal(signupDestination(origin+link),'/?'+query);
 assert.equal(signupViewLink(origin+link,true),link+'&view=signin');
 assert.equal(signupDestination(origin+link+'&view=signin'),'/?'+query);
 assert.equal(signupViewLink(origin+link+'&view=signin',false),link);
});
test('onboarding cannot redirect off-site or carry positions, roles or malformed/duplicate capabilities',()=>{
 for(const fragment of ['next=https://evil.test','returnTo=//evil.test','//evil.test','https://evil.test','room=https://evil.test','room=one&room=two','room=studio&entry=One','room=studio&entry=one&entry=two','invite=one&invite=two','room=..','room=a%0ab','entry=','invite=','room='])assert.equal(signupDestination(origin+'/signup.html#'+fragment),'/',fragment);
 for(const query of ['room=a&room=b','room=','entry=INVALID','invite=a&invite=b'])assert.equal(signupLink(origin+'/?'+query),'/signup.html');
 assert.equal(signupDestination(origin+'/signup.html#room=studio&x=1&role=owner&next=https://evil.test'),'/?room=studio');
 assert.equal(signupDestination('javascript:alert(1)'),'/');assert.equal(signupLink('javascript:alert(1)'),'/signup.html');
});
test('signin intent is nonsecret, reloadable and compatible with existing links',()=>{
 assert(signupStartsWithSignin(origin+'/signup.html#signin'));
 assert(signupStartsWithSignin(origin+'/signup.html#room=studio&view=signin'));
 assert.equal(signupStartsWithSignin(origin+'/signup.html#room=studio'),false);
 assert.equal(signupDestination(origin+'/signup.html#signin'),'/');
 assert.equal(signupViewLink(origin+'/signup.html#signin',false),'/signup.html');
});
test('signup bundle uses only its existing setup-allowed script',async()=>{
 const build=await readFile('scripts/build.mjs','utf8');
 assert.match(build,/entryPoints:\['public\/signup.js'\],outfile:'dist\/signup.js',bundle:true,format:'iife'/);
});
