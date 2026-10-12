import {isIP} from 'node:net';
import {z} from 'zod';
import {isPublicAddress,resolvePublicAddresses} from '../../../src/tools/webFetch/network.js';

const answerSchema=z.object({name:z.string().min(1).max(254),type:z.number().int(),data:z.string().min(1).max(254)});
const responseSchema=z.object({Status:z.literal(0),Question:z.object({name:z.string(),type:z.literal(1)}),Answer:z.array(answerSchema).max(32)});
const normalized=(name:string)=>name.toLowerCase().replace(/\.$/,'');

/** Resolve model endpoints without trusting proxy fake-IP records or changing system DNS. */
export async function modelIpv4(hostname:string):Promise<string[]>{
  const host=normalized(hostname);
  let deadline:ReturnType<typeof setTimeout>|undefined;
  try{
    const addresses=await Promise.race([
      resolvePublicAddresses(host),
      new Promise<never>((_,reject)=>{deadline=setTimeout(()=>reject(Error('Model DNS lookup timed out')),5000);deadline.unref();}),
    ]);
    const ipv4=[...new Set(addresses.filter(value=>value.family===4&&isPublicAddress(value.address)).map(value=>value.address))];
    if(ipv4.length)return ipv4;
  }catch{ /* A validated HTTPS DNS answer may replace unusable local DNS. */ }
  finally{clearTimeout(deadline);}
  const url=new URL('https://dns.alidns.com/resolve');url.searchParams.set('name',host);url.searchParams.set('type','A');
  const response=await fetch(url,{signal:AbortSignal.timeout(5000),redirect:'error',headers:{Accept:'application/dns-json'}});
  if(!response.ok){await response.body?.cancel();throw Error('Public model DNS query failed: HTTP '+response.status);}
  if(!response.body)throw Error('Public model DNS query returned no body');
  const reader=response.body.getReader(),chunks:Uint8Array[]=[];let bytes=0;
  try{
    for(;;){const chunk=await reader.read();if(chunk.done)break;bytes+=chunk.value.length;
      if(bytes>65536)throw Error('Public model DNS response exceeds budget');chunks.push(chunk.value);}
  }finally{await reader.cancel();reader.releaseLock();}
  const record=responseSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  if(normalized(record.Question.name)!==host)throw Error('Public model DNS question mismatch');
  const names=new Set([host]);
  for(let i=0;i<record.Answer.length;i++){
    let changed=false;
    for(const answer of record.Answer)if(answer.type===5&&names.has(normalized(answer.name))&&!names.has(normalized(answer.data))){names.add(normalized(answer.data));changed=true;}
    if(!changed)break;
  }
  const addresses=[...new Set(record.Answer.filter(answer=>answer.type===1&&names.has(normalized(answer.name))).map(answer=>answer.data))];
  if(!addresses.length||addresses.length>16||addresses.some(address=>isIP(address)!==4||!isPublicAddress(address)))
    throw Error('Model endpoint has no validated public IPv4 address');
  return addresses;
}
