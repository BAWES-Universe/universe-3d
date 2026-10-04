import {createHash} from 'node:crypto';
import {readFile,realpath,stat} from 'node:fs/promises';
import {resolve,relative,sep,extname} from 'node:path';
import {fail} from './validation.mjs';

const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.svg':'image/svg+xml','.ico':'image/x-icon','.woff2':'font/woff2','.glb':'model/gltf-binary','.mp3':'audio/mpeg','.ogg':'audio/ogg','.wav':'audio/wav','.mp4':'video/mp4'};
const CSP="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data: https:; media-src 'self' blob: https:; connect-src 'self' ws: wss:; worker-src 'self' blob:; frame-src https:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'";
const ADMISSION_CSP="default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const missing=error=>['ENOENT','ENOTDIR','EISDIR'].includes(error.code);

function preferredEncodings(header){
  if(!header?.trim())return ['identity'];
  const qualities=new Map();
  for(const item of header.toLowerCase().split(',')){
    const [name,...parameters]=item.trim().split(';').map(part=>part.trim());
    if(!['br','gzip','identity','*'].includes(name))continue;
    const valid=parameters.length===0||parameters.length===1&&/^q\s*=\s*(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(parameters[0]);
    const q=valid?(parameters.length?Number(parameters[0].split('=')[1]):1):0;
    // Ambiguous duplicates cannot override an explicit refusal.
    qualities.set(name,Math.min(qualities.get(name)??1,q));
  }
  const quality=name=>qualities.get(name)??(name==='identity'?(qualities.get('*')===0?0:Number.MIN_VALUE):(qualities.get('*')??0));
  // Implicit identity is a fallback; explicit identity participates in q ranking.
  return ['br','gzip','identity'].filter(name=>quality(name)>0).sort((a,b)=>quality(b)-quality(a));
}

function matchesTag(header,etag,{strong=false}={}){
  if(typeof header!=='string')return false;
  if(header.trim()==='*')return true;
  const pattern=/\s*(W\/)?("[\x21\x23-\x7e\x80-\xff]*")\s*(?:,|$)/gy;
  let position=0,matched=false;
  while(position<header.length){
    const match=pattern.exec(header);
    if(!match||match.index!==position)return false;
    if(match[2]===etag&&(!strong||!match[1]))matched=true;
    position=pattern.lastIndex;
  }
  return matched;
}

/** Public build files only. Call after request security and outside /api/. */
export function createStaticAssets({dist}){
  const root=resolve(dist);
  return async function serveStatic(req,res,path){
    if(!['GET','HEAD'].includes(req.method)){res.setHeader('Allow','GET, HEAD');fail(405,'METHOD_NOT_ALLOWED');}
    let requested;
    try{requested=decodeURIComponent(path);}catch{fail(404,'NOT_FOUND');}
    let name=requested==='/'?'index.html':requested.slice(1);
    if(!requested.startsWith('/')||/[\\\0]/.test(name)||name.split('/').some(part=>part.startsWith('.'))||/\.(?:br|gz)$/i.test(name))fail(404,'NOT_FOUND');
    const rootPath=await realpath(root);
    async function readContained(asset){
      const filename=resolve(root,asset);
      if(!filename.startsWith(root+sep))fail(404,'NOT_FOUND');
      const actual=await realpath(filename);
      if(!actual.startsWith(rootPath+sep))fail(404,'NOT_FOUND');
      if(!(await stat(actual)).isFile())throw Object.assign(new Error('Not a file'),{code:'EISDIR'});
      return readFile(actual);
    }
    let source;
    try{source=await readContained(name);}catch(error){
      if(!missing(error))throw error;
      if(extname(name))fail(404,'NOT_FOUND');
      name='index.html';
      try{source=await readContained(name);}catch(error){if(missing(error))fail(404,'NOT_FOUND');throw error;}
    }
    // Canonical lookup also covers extensionless SPA entry requests.
    name=relative(root,resolve(root,name)).split(sep).join('/');
    const sourceHash=hash(source);
    let asset;
    try{
      const manifest=JSON.parse(await readContained('.static-assets.json'));
      const candidate=manifest.version===1&&manifest.assets&&Object.hasOwn(manifest.assets,name)?manifest.assets[name]:null;
      if(candidate?.sha256===sourceHash&&candidate.bytes===source.length)asset=candidate;
    }catch{/* Missing, stale or malformed build metadata safely falls back to identity. */}
    res.setHeader('Vary','Accept-Encoding');
    let selected;
    for(const encoding of preferredEncodings(req.headers['accept-encoding'])){
      if(encoding==='identity'){selected={encoding,bytes:source,digest:sourceHash};break;}
      const record=asset?.encodings?.[encoding];
      if(!record)continue;
      try{
        const bytes=await readContained(name+(encoding==='br'?'.br':'.gz'));
        const digest=hash(bytes);
        if(bytes.length===record.bytes&&digest===record.sha256){selected={encoding,bytes,digest};break;}
      }catch{/* Never serve an unverified, absent or stale precompressed artifact. */}
    }
    if(!selected){res.writeHead(406,{'Cache-Control':'no-store','Content-Length':'0'});res.end();return;}
    const etag=`"sha256-${selected.digest}"`;
    // Range is deliberately unsupported: always send the complete negotiated
    // representation, never byte offsets computed against uncompressed content.
    if(req.headers['if-match']!==undefined&&!matchesTag(req.headers['if-match'],etag,{strong:true})){
      res.writeHead(412,{'Cache-Control':'no-store','Content-Length':'0'});res.end();return;
    }
    const immutable=asset?.immutable===true&&/^chunks\/[^/]+-[A-Z0-9]{8}\.(?:js|css)$/.test(name);
    const admissionDocument=name==='join.html';
    res.setHeader('Cache-Control',admissionDocument?'no-store':immutable?'public, max-age=31536000, immutable':'no-cache');
    res.setHeader('ETag',etag);
    res.setHeader('Accept-Ranges','none');
    res.setHeader('Content-Type',MIME[extname(name)]||'application/octet-stream');
    res.setHeader('Content-Security-Policy',admissionDocument?ADMISSION_CSP:CSP);
    if(admissionDocument){res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Cross-Origin-Resource-Policy','same-origin');}
    if(selected.encoding!=='identity')res.setHeader('Content-Encoding',selected.encoding);
    // ETags avoid false freshness when mutable files change within one second.
    // We deliberately do not issue Last-Modified or evaluate date validators.
    if(matchesTag(req.headers['if-none-match'],etag)){res.writeHead(304);res.end();return;}
    res.setHeader('Content-Length',selected.bytes.length);
    res.writeHead(200);res.end(req.method==='HEAD'?undefined:selected.bytes);
  };
}
