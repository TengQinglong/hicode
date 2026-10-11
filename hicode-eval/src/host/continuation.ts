import {constants} from 'node:fs';
import {open,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {z} from 'zod';
import {checkpointSchema,done} from './types.js';
import type {Run,Checkpoint} from './types.js';
import type {EvalLayout} from './layout.js';
import {readJson} from './store.js';

export const environmentDigest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

export async function verifyCheckpointArchive(path:string,checkpoint:Checkpoint){
  if(await realpath(path)!==path)throw Error('Symlinked continuation archive');
  const fd=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW),hash=createHash('sha256');
  try{
    const stat=await fd.stat();if(!stat.isFile()||stat.size!==checkpoint.bytes)throw Error('Continuation archive size changed');
    const buffer=Buffer.alloc(65536);for(;;){const {bytesRead}=await fd.read(buffer);if(!bytesRead)break;hash.update(buffer.subarray(0,bytesRead));}
    if(hash.digest('hex')!==checkpoint.sha256)throw Error('Continuation archive hash changed');
  }finally{await fd.close();}
}

/** Only the sealed, pre-verifier checkpoint can become a new Actor input. */
export async function readCheckpoint(layout:EvalLayout,state:Run):Promise<Checkpoint>{
  if(!done(state.state)||state.state==='needs_recovery'||state.state==='passed'||state.collection!=='complete'
      ||!['timeout','cancelled','failed'].includes(state.execution))throw Error('Continue requires a stopped, fully collected attempt');
  const path=join(layout.run(state.id),'evidence');
  const checkpoint=await readJson(join(path,'continuation.json'),checkpointSchema,4096);
  if(checkpoint.runId!==state.id)throw Error('Continuation checkpoint belongs to another attempt');
  const receipt=await readJson(join(layout.run(state.id),'collection.json'),z.object({complete:z.literal(true),
    files:z.record(z.object({bytes:z.number(),sha256:z.string(),symlink:z.string().optional()}).strict())}).strict(),32*1024*1024);
  const recorded=receipt.files['continuation.tar.gz'];
  if(!recorded||recorded.symlink||recorded.bytes!==checkpoint.bytes||recorded.sha256!==checkpoint.sha256)
    throw Error('Continuation checkpoint differs from collection receipt');
  const metadata=receipt.files['continuation.json'];
  if(!metadata||metadata.symlink||metadata.bytes>4096)throw Error('Continuation metadata is not collected');
  await verifyCheckpointArchive(join(path,'continuation.json'),{...checkpoint,bytes:metadata.bytes,sha256:metadata.sha256});
  await readJson(join(layout.run(state.id),'container-disposed.json'),z.object({version:z.literal(1),runId:z.literal(state.id),at:z.string().datetime()}).strict());
  await verifyCheckpointArchive(join(path,'continuation.tar.gz'),checkpoint);
  return checkpoint;
}
