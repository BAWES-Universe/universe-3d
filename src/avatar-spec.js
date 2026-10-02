/** Original Universe wardrobe. Portable data only: safe to import in the server.
 * Catalogue ownership and placed-world-asset permissions deliberately do not live
 * in an appearance. Every item in this original catalogue is available to all users.
 */
export const AVATAR_CATALOG = 'universe-original-v1';
const choices = entries => Object.freeze(entries.map(([id, label]) => Object.freeze({ id, label })));
export const AVATAR_OPTIONS = Object.freeze({
  height: choices([['petite','Petite'],['average','Medium'],['tall','Tall']]),
  build: choices([['slim','Slender'],['balanced','Balanced'],['soft','Rounded']]),
  hairStyle: choices([['sweep','Side sweep'],['crop','Cropped'],['curls','Soft curls'],['bob','Rounded bob'],['bun','High bun'],['spikes','Tousled'],['bald','Clean shaven']]),
  topStyle: choices([['jacket','Varsity jacket'],['hoodie','Cozy hoodie'],['tee','Everyday tee']]),
  bottomStyle: choices([['pants','Tapered trousers'],['shorts','Weekend shorts'],['skirt','A-line skirt']]),
  shoeStyle: choices([['sneakers','Low-top sneakers'],['boots','Ankle boots']]),
  hat: choices([['none','No hat'],['beanie','Ribbed beanie'],['cap','Soft cap']]),
  glasses: choices([['none','No glasses'],['round','Round frames'],['square','Square frames']]),
  bag: choices([['none','No bag'],['backpack','Day backpack'],['satchel','Crossbody satchel']]),
  headphones: choices([['none','No headphones'],['over-ear','Over-ear headphones']]),
});
export const AVATAR_PALETTES = Object.freeze({
  skin: Object.freeze(['#f4d5b5','#e6b68b','#cb9169','#aa7050','#804d38','#57362b','#f0c2ae','#bc806c']),
  hairColor: Object.freeze(['#252237','#47332e','#78503b','#a9754c','#d8b574','#eee2cd','#8163ad','#cb6e79','#437d82']),
  eyeColor: Object.freeze(['#252237','#573b2b','#35675e','#5379a2','#80629f']),
  topColor: Object.freeze(['#8570c9','#5f5598','#e3b852','#d2737d','#4e8b89','#496681','#efe5d3','#33364b']),
  bottomColor: Object.freeze(['#303449','#525f78','#7d6a66','#9b8cba','#ded1b5','#426c70','#925661','#343e3a']),
  shoeColor: Object.freeze(['#f2e9d9','#33364b','#8063b5','#d5a747','#a55f62','#4f8587']),
});
export const DEFAULT_APPEARANCE = Object.freeze({version:1,catalog:AVATAR_CATALOG,body:Object.freeze({height:'average',build:'balanced'}),skin:'#e6b68b',hairStyle:'sweep',hairColor:'#252237',eyeColor:'#252237',topStyle:'jacket',topColor:'#8570c9',bottomStyle:'pants',bottomColor:'#303449',shoeStyle:'sneakers',shoeColor:'#f2e9d9',hat:'none',glasses:'none',bag:'none',headphones:'none'});
const clone = a => ({...a,body:{...a.body}});
const preset = (id,name,values) => Object.freeze({id,name,appearance:Object.freeze({...DEFAULT_APPEARANCE,...values,body:Object.freeze({...DEFAULT_APPEARANCE.body,...values.body})})});
export const AVATAR_PRESETS = Object.freeze([
  preset('violet','Violet explorer',{}),
  preset('golden','Golden hour',{skin:'#804d38',hairStyle:'curls',hairColor:'#47332e',topStyle:'hoodie',topColor:'#e3b852',bottomColor:'#525f78',glasses:'round'}),
  preset('rose','Rose wanderer',{skin:'#f4d5b5',hairStyle:'bob',hairColor:'#cb6e79',topStyle:'tee',topColor:'#d2737d',bottomStyle:'skirt',bottomColor:'#303449',shoeStyle:'boots',shoeColor:'#33364b'}),
  preset('moss','Moss maker',{skin:'#cb9169',hairStyle:'crop',hairColor:'#252237',topColor:'#4e8b89',bottomStyle:'shorts',bottomColor:'#ded1b5',hat:'beanie'}),
  preset('cloud','Cloud dreamer',{skin:'#57362b',hairStyle:'bun',hairColor:'#252237',topStyle:'hoodie',topColor:'#efe5d3',bottomColor:'#9b8cba',bag:'backpack'}),
  preset('ocean','Ocean listener',{skin:'#f0c2ae',hairStyle:'spikes',hairColor:'#437d82',topStyle:'tee',topColor:'#496681',bottomColor:'#303449',headphones:'over-ear'}),
]);
function invalid(field) {const error=new Error(`Choose a valid ${field.replace(/([A-Z])/g,' $1').toLowerCase()} from the original Universe wardrobe.`);error.code='INVALID_APPEARANCE';error.status=400;error.field=field;throw error;}
function object(value,field){if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))invalid(field);}
export function validateAppearance(value) {
  object(value,'appearance');
  if(value.version!==1)invalid('version');
  if(value.catalog!==AVATAR_CATALOG)invalid('catalog');
  const keys=Object.keys(DEFAULT_APPEARANCE);
  if(Object.keys(value).some(key=>!keys.includes(key)))invalid('appearance field');
  object(value.body,'body');
  if(Object.keys(value.body).some(key=>!['height','build'].includes(key)))invalid('body field');
  for(const key of ['height','build'])if(!AVATAR_OPTIONS[key].some(option=>option.id===value.body[key]))invalid(key);
  for(const [key,options] of Object.entries(AVATAR_OPTIONS))if(!['height','build'].includes(key)&&!options.some(option=>option.id===value[key]))invalid(key);
  for(const [key,colors]of Object.entries(AVATAR_PALETTES))if(typeof value[key]!=='string'||!colors.includes(value[key].toLowerCase()))invalid(key);
  const result=clone(DEFAULT_APPEARANCE);
  for(const key of keys)if(key!=='body')result[key]=AVATAR_PALETTES[key]?value[key].toLowerCase():value[key];
  result.body={height:value.body.height,build:value.body.build};
  return result;
}
/** Compatibility is for reading old saved profiles, never for validating writes. */
export function normalizeAppearance(value) {
  try{return validateAppearance(value);}catch{/* Old numeric Wokas become original presets. */}
  if(value&&typeof value==='object'&&value.appearance)return normalizeAppearance(value.appearance);
  if(typeof value==='number'&&Number.isInteger(value))return clone(AVATAR_PRESETS[Math.abs(value)%AVATAR_PRESETS.length].appearance);
  if(typeof value==='string'&&/^\d+$/.test(value))return normalizeAppearance(Number(value));
  const result=clone(DEFAULT_APPEARANCE);
  if(value&&typeof value==='object'){
    const legacy={topColor:value.outfit||value.body,hairColor:value.hair};
    for(const [key,color]of Object.entries(legacy))if(typeof color==='string'&&AVATAR_PALETTES[key].includes(color.toLowerCase()))result[key]=color.toLowerCase();
  }
  return result;
}
export const appearanceForUser = user => normalizeAppearance(user?.appearance ?? user?.woka);
export const appearanceKey = value => JSON.stringify(normalizeAppearance(value));
export const avatarPreset = id => clone((AVATAR_PRESETS.find(p=>p.id===id)||AVATAR_PRESETS[0]).appearance);
