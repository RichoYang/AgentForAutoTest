import {createHash} from 'node:crypto';
// Dataset rows are JSON-safe flat records. Keep exactly JSON.stringify's byte
// representation without constructing one string for the entire row array.
export function* datasetJsonParts(value){
 if(value===null||typeof value!=='object'||typeof value.toJSON==='function'){yield JSON.stringify(value);return;}
 if(Array.isArray(value)){
  yield '[';for(let i=0;i<value.length;i++){if(i)yield ',';const item=value[i];if(item&&typeof item==='object'&&(Array.isArray(item)||Object.values(item).some(v=>v&&typeof v==='object')))yield* datasetJsonParts(item);else yield JSON.stringify(item)??'null';}yield ']';return;
 }
 yield '{';let comma=false;for(const key of Object.keys(value)){const item=value[key];if(item===undefined||typeof item==='function'||typeof item==='symbol')continue;if(comma)yield ',';comma=true;yield JSON.stringify(key)+':';yield* datasetJsonParts(item);}yield '}';
}
export function datasetJsonStats(value){const digest=createHash('sha256');let bytes=0;for(const part of datasetJsonParts(value)){if(part===undefined)throw new Error('Dataset JSON value is not serializable');bytes+=Buffer.byteLength(part);digest.update(part);}return {bytes,hash:digest.digest('hex')};}
export const datasetHash=value=>datasetJsonStats(value).hash;
export function datasetBytes(value,limit=Infinity){let bytes=0;for(const part of datasetJsonParts(value)){bytes+=Buffer.byteLength(part);if(bytes>limit)return limit+1;}return bytes;}
