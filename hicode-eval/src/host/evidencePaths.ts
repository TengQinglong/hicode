import {constants} from 'node:fs';
import {open} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {exists} from './store.js';

const mapName='.hicode-evidence-paths.json';
const path=z.string().min(1).max(4096).refine(value=>!value.includes('\0')&&!value.startsWith('/')&&
  value.split('/').every(part=>part!==''&&part!=='.'&&part!=='..'),'Invalid evidence path');
const mapSchema=z.object({version:z.literal(1),entries:z.array(z.object({stored:path,original:path}).strict()).max(100000)}).strict();

/** Storage names are data; restore original names only in a Linux verifier copy. */
export async function evidencePathMap(evidence:string,files:Readonly<Record<string,{bytes:number;sha256:string;symlink?:string}>>):Promise<Buffer|undefined>{
  const file=join(evidence,mapName),receipt=files[mapName];
  if(!receipt){if(await exists(file))throw Error('Unsealed evidence path map');return;}
  if(receipt.symlink!==undefined||receipt.bytes>16*1024*1024)throw Error('Invalid evidence map receipt');
  const fd=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
    const stat=await fd.stat();if(!stat.isFile()||stat.size!==receipt.bytes)throw Error('Invalid evidence map size/type');
    const content=await fd.readFile();
    if(createHash('sha256').update(content).digest('hex')!==receipt.sha256)throw Error('Evidence path map differs from receipt');
    mapSchema.parse(JSON.parse(content.toString('utf8')));return content;
  }finally{await fd.close();}
}
