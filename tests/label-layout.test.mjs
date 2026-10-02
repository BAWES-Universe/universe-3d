import test from 'node:test';import assert from'node:assert/strict';import{labelFits,rectanglesOverlap}from'../src/label-layout.js';
const rect=(left,top,width,height)=>({left,top,right:left+width,bottom:top+height,width,height});
test('actual label width and height are protected rather than just anchor y',()=>{const view=rect(0,0,1280,800),hud=rect(510,25,260,95);assert.equal(labelFits(rect(470,105,100,25),view,[hud],9),false);assert.equal(labelFits(rect(100,105,100,25),view,[hud],9),true);});
test('padding prevents almost-touching labels while accepting clear anchors',()=>{const view=rect(0,0,390,844),hud=rect(90,80,210,70);assert.equal(labelFits(rect(100,156,90,18),view,[hud],9),false);assert.equal(labelFits(rect(100,166,90,18),view,[hud],9),true);});
test('offscreen label edges are hidden even when anchor is on screen',()=>{assert.equal(labelFits(rect(-20,200,100,20),rect(0,0,390,844),[]),false);assert.equal(rectanglesOverlap(rect(0,0,10,10),rect(10,0,10,10)),false);});
