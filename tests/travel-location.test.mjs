import test from 'node:test';
import assert from 'node:assert/strict';
import {readTravelLocation,writeTravelLocation,shareDestinationUrl,validateDestination,destinationKey} from '../src/travel-location.js';

test('arrival links preserve named/default identity without coordinates or membership',()=>{
  assert.deepEqual(readTravelLocation('https://game.invalid/?room=commons&entry=cafe'),{roomId:'commons',entry:'cafe',invite:null});
  assert.deepEqual(readTravelLocation('https://game.invalid/?room=commons'),{roomId:'commons',entry:undefined,invite:null});
  assert.deepEqual(readTravelLocation('https://game.invalid/?entry=cafe&x=99&role=owner'),{roomId:null,entry:'cafe',invite:null});
  assert.notEqual(destinationKey({roomId:'commons'}),destinationKey({roomId:'commons',entry:'cafe'}));
  assert.equal(destinationKey({roomId:'commons',entry:undefined}),destinationKey({roomId:'commons'}));
});

test('malformed or duplicate link selectors reject without guessing a destination',()=>{
  for(const query of ['room=','entry=','room=a&room=b','entry=a&entry=b','invite=a&invite=b','room=../private','entry=Cafe','entry=a%2Fb','entry=%00','invite=a/b'])assert.throws(()=>readTravelLocation('https://game.invalid/?'+query),query);
  for(const url of ['javascript:alert(1)','file:///tmp/room','data:text/plain,room'])assert.throws(()=>readTravelLocation(url));
  for(const entry of [null,2,{},'has space','a'.repeat(65)])assert.throws(()=>validateDestination({roomId:'commons',entry}));
});

test('share link strips invitation, unrelated query and fragment while history updates preserve unrelated local settings',()=>{
  const base='https://game.invalid/play?room=old&entry=old&invite=capability&token=private&quality=low#fragment';
  assert.equal(shareDestinationUrl(base,{roomId:'commons',entry:'garden'}),'https://game.invalid/play?room=commons&entry=garden');
  assert.equal(shareDestinationUrl(base,{roomId:'commons'}),'https://game.invalid/play?room=commons');
  const history=new URL(writeTravelLocation(base,{roomId:'commons'}));
  assert.equal(history.searchParams.get('quality'),'low');assert.equal(history.searchParams.has('entry'),false);assert.equal(history.searchParams.has('invite'),false);
});
