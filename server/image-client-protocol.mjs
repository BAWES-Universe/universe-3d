import {IMAGE_PHYSICAL_SIZE_CAPABILITY,CLIENT_CAPABILITIES_HEADER} from '../src/client-protocol.js';
export const IMAGE_PROTOCOL_FLOOR_KEY='image_physical_size_protocol_floor';
export const IMAGE_RELOAD_MESSAGE='Reload this page to use the updated image sizes. Your unsaved room draft is kept so you can export it before reloading.';
const binaryRead=(path,method)=>['GET','HEAD'].includes(method)&&(/^\/api\/rooms\/[A-Za-z0-9_-]{1,80}\/files\/[A-Za-z0-9_-]{1,80}$/.test(path)||/^\/api\/rooms\/[A-Za-z0-9_-]{1,128}\/assets\/[A-Za-z0-9_-]{1,128}\/versions\/[A-Za-z0-9_-]{1,128}\/image$/.test(path));
const admission=(path,method)=>path==='/api/site-invites'&&['GET','POST'].includes(method)||method==='POST'&&(['/api/site-admission/check','/api/site-admission/redeem'].includes(path)||/^\/api\/site-invites\/[A-Za-z0-9_-]{1,80}\/revoke$/.test(path));
const exempt=(path,method)=>admission(path,method)||binaryRead(path,method)||['/api/health','/api/access','/api/client-protocol'].includes(path)||method==='POST'&&['/api/session','/api/login','/api/logout'].includes(path);
/** A version declaration only. Existing cookie/room authorization still applies. */
export function acceptsImageProtocol(req){
 const url=new URL(req.url,'http://127.0.0.1');
 const value=req.headers[CLIENT_CAPABILITIES_HEADER.toLowerCase()];
 const declares=value=>typeof value==='string'&&value.length<=512&&value.split(/[\s,]+/).includes(IMAGE_PHYSICAL_SIZE_CAPABILITY);
 return declares(value)||url.pathname==='/api/events'&&declares(url.searchParams.get('capabilities'));
}
/** Single-writer process policy. Metadata records a minimum reader, never rewrites image geometry. */
export function createImageClientProtocol({store,enabled=false,onChange=()=>{}}){
 if(typeof enabled!=='boolean')throw new TypeError('imagePhysicalSizeEnabled must be boolean');
 const floorRow=store.get('SELECT value FROM metadata WHERE key=?',IMAGE_PROTOCOL_FLOOR_KEY);
 if(floorRow&&floorRow.value!==IMAGE_PHYSICAL_SIZE_CAPABILITY)throw new Error('This database requires a newer image client protocol');
 const table=store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='room_image_asset_versions'");
 const sized=table&&store.get("SELECT 1 FROM room_image_asset_versions WHERE json_type(version_json,'$.widthMetres') IS NOT NULL OR json_type(version_json,'$.heightMetres') IS NOT NULL LIMIT 1");
 let required=!!floorRow||!!sized||enabled,writesEnabled=enabled;
 function persistFloor(){store.run('INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',IMAGE_PROTOCOL_FLOOR_KEY,IMAGE_PHYSICAL_SIZE_CAPABILITY);}
 if(required)persistFloor();
 const status=()=>({imagePhysicalSize:{enabled:writesEnabled,required,capability:IMAGE_PHYSICAL_SIZE_CAPABILITY},storageCompatibility:{version:1,requiredReaderCapabilities:required?[IMAGE_PHYSICAL_SIZE_CAPABILITY]:[]}});
 function assertRequest(req){
  const url=new URL(req.url,'http://127.0.0.1');
  // SSE must deliver a compatible retirement envelope, not an opaque HTTP error.
  if(!required||url.pathname==='/api/events'||exempt(url.pathname,req.method)||acceptsImageProtocol(req))return;
  const error=new Error(IMAGE_RELOAD_MESSAGE);error.status=426;error.code='CLIENT_RELOAD_REQUIRED';error.details=status();throw error;
 }
 return Object.freeze({status,assertRequest,accepts:acceptsImageProtocol,isEnabled:()=>writesEnabled,isRequired:()=>required,
  // Factory test seam only. Process configuration/restart is the supported operator path.
  setEnabledForTest(value){if(typeof value!=='boolean')throw new TypeError('Image physical-size policy must be boolean');if(value)persistFloor();required=required||value;writesEnabled=value;onChange(status());return status();}
 });
}

/** Pure release-check seam: inspect trusted storage requirements and target JSON,
 * never execute target code or assume an absent descriptor is legacy-safe. */
export function checkImageReaderCompatibility(storage,target){
 const known=value=>Array.isArray(value)&&value.every(item=>item===IMAGE_PHYSICAL_SIZE_CAPABILITY)&&new Set(value).size===value.length;
 if(!storage||storage.version!==1||!known(storage.requiredReaderCapabilities))return {compatible:false,code:'IMAGE_STORAGE_REQUIREMENT_INVALID'};
 if(target===undefined||target===null)return {compatible:false,code:'IMAGE_READER_DESCRIPTOR_MISSING'};
 if(target.version!==1||!known(target.readerCapabilities)||Object.keys(target).some(key=>!['version','readerCapabilities'].includes(key)))return {compatible:false,code:'IMAGE_READER_DESCRIPTOR_INVALID'};
 if(!storage.requiredReaderCapabilities.every(capability=>target.readerCapabilities.includes(capability)))return {compatible:false,code:'IMAGE_READER_CAPABILITY_MISSING'};
 return {compatible:true,code:'IMAGE_READER_COMPATIBLE'};
}
