import {createHash} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {z} from 'zod';
import {EVAL_ROOT} from '../paths.js';
import {readJson,run} from './store.js';
import {checkpointSchema,done,runSchema,batchSchema,continuationFor} from './types.js';
import type {Run,Checkpoint} from './types.js';
import {EvalLayout} from './layout.js';

const shutdownSchema=z.object({version:z.literal(1),reason:z.literal('timeout'),cliExited:z.literal(true),
  turnSaved:z.literal(true),pendingToolCallIds:z.array(z.string()).length(0),eventStreamComplete:z.literal(true),error:z.null()});

/** A UI hint only; full receipt, file and execution-module checks happen on explicit recovery. */
export async function deepActorElapsed(path:string,state:Run):Promise<number>{
  const layout=new EvalLayout(dirname(dirname(path))),source=await actorSource(layout,state);
  await readJson(join(layout.run(source.id),'evidence/shutdown.json'),shutdownSchema,4096);
  await readJson(join(path,'container-disposed.json'),z.object({version:z.literal(1),runId:z.literal(state.id),at:z.string().datetime()}).strict());
  return source.budget.agentSeconds;
}

async function actorSource(layout:EvalLayout,state:Run):Promise<Run>{
  if(state.dataset!=='deep-swe'||!done(state.state)||state.state==='needs_recovery'||state.state==='passed'
      ||state.collection!=='complete')throw Error('No stopped DeepSWE Actor');
  if(state.execution==='timeout')return state;
  if(!['failed','cancelled'].includes(state.execution)||state.grading!=='unavailable')throw Error('No startup failure to restore');
  const parent=await readJson(layout.batch(state.batchId),batchSchema),origin=continuationFor(parent,state.id);
  if(!origin||origin.inputSource!=='sealed-deep-actor')throw Error('No sealed original input');
  const source=await readJson(join(layout.run(origin.checkpoint.runId),'state.json'),runSchema);
  if(source.task!==state.task||source.dataset!==state.dataset||source.execution!=='timeout')throw Error('Original Actor identity changed');
  return source;
}

/** Explicitly recover only collected Actor files; never mutate original evidence or its receipt. */
export async function prepareDeepActor(layout:EvalLayout,state:Run):Promise<{checkpoint:Checkpoint;archive:string;close:()=>Promise<void>}>{
  await deepActorElapsed(layout.run(state.id),state);
  const source=await actorSource(layout,state);
  const stage=await mkdtemp(join(layout.builds,'deep-continuation-'));
  const close=()=>rm(stage,{recursive:true,force:true});
  try{
    const hashes:Record<string,string>={};
    for(const name of ['runner.py','protocol.py','cleanup.py','eval_datasets/deep_swe.py'])
      hashes[name]=createHash('sha256').update(await readFile(join(EVAL_ROOT,'src/worker',name))).digest('hex');
    const output=await run(['python3',join(EVAL_ROOT,'src/worker/deep_checkpoint.py'),layout.run(source.id),stage,JSON.stringify(hashes),
      ...(source.id!==state.id?[layout.run(state.id)]:[])],{timeout:300000});
    const checkpoint=checkpointSchema.parse(JSON.parse(output));
    if(checkpoint.runId!==source.id)throw Error('Recovered Actor belongs to another Run');
    return {checkpoint,archive:join(stage,'continuation.tar.gz'),close};
  }catch(error){await close();throw error;}
}
