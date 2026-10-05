import {CLIENT_CAPABILITIES_HEADER} from '../src/client-protocol.js';
import * as v from './validation.mjs';
export const FURNITURE_CAPABILITY='composition-furniture-v1';
export const FURNITURE_RELOAD_MESSAGE='Reload this page to use custom furniture. Your unsaved room draft is kept so you can export it before reloading.';
export function acceptsFurnitureProtocol(req){
 const url=new URL(req.url,'http://127.0.0.1'),declares=value=>typeof value==='string'&&value.length<=512&&value.split(/[\s,]+/).includes(FURNITURE_CAPABILITY);
 return declares(req.headers[CLIENT_CAPABILITIES_HEADER.toLowerCase()])||url.pathname==='/api/events'&&declares(url.searchParams.get('capabilities'));
}
export function createFurnitureClientProtocol({store,onChange=()=>{}}){
 store.db.exec('CREATE TABLE IF NOT EXISTS room_furniture_protocol_floor(room_id TEXT PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,capability TEXT NOT NULL)');
 if(store.get('SELECT 1 FROM room_furniture_protocol_floor WHERE capability!=? LIMIT 1',FURNITURE_CAPABILITY))throw new Error('This database requires a newer furniture client protocol');
 for(const row of store.all('SELECT id,scene FROM rooms'))if(JSON.parse(row.scene).objects?.some(object=>object.type==='composition'))store.run('INSERT OR IGNORE INTO room_furniture_protocol_floor(room_id,capability) VALUES(?,?)',row.id,FURNITURE_CAPABILITY);
 const required=roomId=>!!roomId&&!!store.get('SELECT 1 FROM room_furniture_protocol_floor WHERE room_id=?',roomId);
 const status=()=>({compositionFurniture:{capability:FURNITURE_CAPABILITY,required:!!store.get('SELECT 1 FROM room_furniture_protocol_floor LIMIT 1')}});
 function requireCapable(capable){if(!capable)v.fail(426,'CLIENT_RELOAD_REQUIRED',FURNITURE_RELOAD_MESSAGE,status());}
 function assertRequest(req){
  const url=new URL(req.url,'http://127.0.0.1'),match=url.pathname.match(/^\/api\/rooms\/([A-Za-z0-9_-]+)(?:\/|$)/);
  if(match&&(required(match[1])||/\/furniture(?:\/|$)/.test(url.pathname)))requireCapable(acceptsFurnitureProtocol(req));
 }
 return Object.freeze({status,accepts:acceptsFurnitureProtocol,required,assertRequest,requireCapable,
  // Called in the same scene transaction. No cached flag survives its rollback.
  requireRoom(roomId){store.run('INSERT OR IGNORE INTO room_furniture_protocol_floor(room_id,capability) VALUES(?,?)',roomId,FURNITURE_CAPABILITY);},
  notifyRoom(roomId){if(required(roomId))onChange(roomId,status());}
 });
}
