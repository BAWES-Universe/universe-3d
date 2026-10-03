import test from 'node:test';
import assert from 'node:assert/strict';
import {contentWindowLayout} from '../src/window-layout.js';
const layout=options=>contentWindowLayout({viewportWidth:1440,viewportHeight:900,...options});
test('expand uses measured game width at the exact desktop boundary',()=>{
 assert.equal(layout({gameWidth:1023,maximized:true}).maximized,false);
 assert.equal(layout({gameWidth:1024,maximized:true}).maximized,true);
 assert.equal(layout({gameWidth:1024,maximized:true}).width,1440);
 assert.equal(layout({viewportWidth:1920,gameWidth:900}).canMaximize,false);
});
test('authored default keeps current control lane, deliberate resize uses source bounds',()=>{
 assert.equal(layout({authoredWidth:60}).width,864);
 assert.equal(layout({authoredWidth:90}).width,1080);
 assert.equal(layout({customWidth:100}).width,200);
 assert.equal(layout({customWidth:2000}).width,1390);
 assert.equal(layout({customWidth:700,maximized:true}).width,1440);
 assert.equal(layout({customWidth:700}).width,700);
});
test('small or short sheets keep content safe and shrink always fits available space',()=>{
 for(const [width,height]of[[320,568],[390,844],[844,390],[650,700]]){
  const state=layout({viewportWidth:width,viewportHeight:height,customWidth:1500});
  assert.equal(state.width,width);assert.equal(state.canResize,false);
 }
 assert.equal(layout({viewportWidth:844,viewportHeight:700,customWidth:2000}).width,794);
 assert.equal(layout({viewportWidth:1023,viewportHeight:800,maximized:true}).maximized,false);
});
