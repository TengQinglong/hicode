import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile,realpath,open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join} from 'node:path';
import {z} from 'zod';
import {isDeepStrictEqual} from 'node:util';
import {idSchema,terminalRegradeResultSchema,terminalRegradeRequestSchema} from './types.js';
import type {Config,Run,TerminalRegradeResult} from './types.js';
import {readJson,save,run,runEvidenceTree} from './store.js';
import {RunContainers} from './containers.js';
import type {CatalogTask} from './catalog.js';
import {EnvironmentStore} from './environments.js';
import {taskAdapters} from './datasets.js';
import {EvalLayout} from './layout.js';
import type {WorkerBundle} from './workerBundle.js';
import {evidencePathMap} from './evidencePaths.js';

const hash=z.string().regex(/^[a-f0-9]{64}$/);
const file=z.object({bytes:z.number().int().nonnegative(),sha256:hash,symlink:z.string().optional()}).strict();
const digest=(content:string|Buffer)=>createHash('sha256').update(content).digest('hex');
export class TerminalRegradeCleanupError extends Error {}

/** The execution owner supplies frozen dependencies; this verifier never writes grades. */
export async function regradeTerminal(config:Config,state:Run,task:CatalogTask,restartScript:string|undefined,bundle:WorkerBundle,reviewId:string,signal:AbortSignal){
  signal.throwIfAborted();idSchema.parse(reviewId);
  const deep=state.dataset==='deep-swe';
  if((state.dataset!=='terminal-bench-2.1'&&!deep)||(state.execution!=='completed'&&!(deep&&state.execution==='cancelled'&&state.grading==='unavailable'))
    ||state.collection!=='complete'||!['passed','failed','error','cancelled'].includes(state.state))
    throw Error('Regrade requires a completed and fully collected Terminal run');
  const layout=new EvalLayout(config.data),original=layout.run(state.id),evidence=join(original,'evidence');
  const receipt=await readJson(join(original,'collection.json'),z.object({complete:z.literal(true),files:z.record(file)}).strict(),32*1024*1024);
  const expected=Object.fromEntries(Object.entries(receipt.files).filter(([name])=>name.startsWith('project/')).map(([name,value])=>[name.slice(8),value]));
  const project=join(evidence,'project'),snapshot=join(evidence,'service-system.tar');
  for(const path of [original,evidence,project])if(await realpath(path)!==path)throw Error('Symlinked collected evidence');
  if(!Object.keys(expected).length||!isDeepStrictEqual(await runEvidenceTree(project),expected))throw Error('Collected answer differs from its receipt');
  const pathMap=await evidencePathMap(evidence,receipt.files);
  const taskRoot=join(original,'task',state.task),plan=await taskAdapters(layout)[state.dataset].execution(state,taskRoot);
  const oldJob=await readJson(join(original,'job.json'),z.record(z.unknown()));
  if(!isDeepStrictEqual(plan.job.service,oldJob.service))throw Error('Service declaration changed since the original run');
  let snapshotBytes:Buffer|undefined;
  if(plan.job.service){
    if(restartScript===undefined)throw Error('Service regrade requires a reviewed restart script');
    if(await realpath(snapshot)!==snapshot)throw Error('Symlinked collected service snapshot');
    const snapshotHandle=await open(snapshot,constants.O_RDONLY|constants.O_NOFOLLOW);
    try{const stat=await snapshotHandle.stat();if(!stat.isFile()||stat.size>512*1024*1024)throw Error('Invalid service snapshot size/type');snapshotBytes=await snapshotHandle.readFile();}
    finally{await snapshotHandle.close();}
    if(receipt.files['service-system.tar']?.sha256!==digest(snapshotBytes))throw Error('Collected service snapshot differs from its receipt');
  }else if(restartScript!==undefined)throw Error('Ordinary Terminal regrade does not accept a restart script');
  let eventsBytes:Buffer|undefined;
  if(plan.job.service){
    await readJson(join(evidence,'shutdown.json'),z.object({reason:z.literal('completed'),cliExited:z.literal(true),turnSaved:z.literal(true),
      pendingToolCallIds:z.array(z.string()).length(0),eventStreamComplete:z.literal(true),error:z.null()}).passthrough());
  }else{
    const eventsHandle=await open(join(evidence,'actor-events/events.jsonl'),constants.O_RDONLY|constants.O_NOFOLLOW);
    try{const stat=await eventsHandle.stat();if(!stat.isFile()||stat.size>256*1024*1024)throw Error('Invalid completion event evidence');eventsBytes=await eventsHandle.readFile();}
    finally{await eventsHandle.close();}
    if(receipt.files['actor-events/events.jsonl']?.sha256!==digest(eventsBytes))throw Error('Completion events differ from their receipt');
  }
  await readJson(join(original,'container-disposed.json'),z.object({version:z.literal(1),runId:z.literal(state.id),at:z.string().datetime()}).strict());
  terminalRegradeRequestSchema.parse({run:state.id,restartScript});
  const script=restartScript===undefined?undefined:Buffer.from(restartScript);if(script&&script.length>16384)throw Error('Invalid operator service restart script');
  const payload=await readFile(join(config.payload,'source.tar.gz')),release='/opt/hicode/releases/'+digest(payload);
  if(oldJob.release!==release)throw Error('Original frozen runtime payload is not available');
  const output=layout.recheck(state.id,reviewId);
  await mkdir(output,{recursive:true,mode:0o700});
  const input={version:1,runId:state.id,reviewId,createdAt:new Date().toISOString(),originalExecution:state.execution,originalGrading:state.grading,
    ...(pathMap?{pathMapSha256:digest(pathMap)}:{}),
    projectSha256:digest(JSON.stringify(expected)),...(snapshotBytes&&script?{snapshotSha256:digest(snapshotBytes),restartSha256:digest(script)}:{kind:'ordinary',eventsSha256:digest(eventsBytes!)})};
  await save(join(output,'input.json'),input);if(script)await writeFile(join(output,'service-restart.sh'),script,{mode:0o600});
  if(pathMap)await writeFile(join(output,'evidence-paths.json'),pathMap,{mode:0o600});
  if(eventsBytes)await writeFile(join(output,'completion-events.jsonl'),eventsBytes,{mode:0o600});
  if(task.dataset!==state.dataset||task.id!==state.task)throw Error('Recheck task identity mismatch');
  const binding=await new EnvironmentStore(config.environments,config.context,config.datasetBackends).resolve(task);
  const containers=new RunContainers(config),container=await containers.create(reviewId,(binding.preparation??binding.dependencies).imageId);
  const docker=(...args:string[])=>['docker','--context',config.context,...args],remote='/eval/rechecks/'+state.id+'/'+reviewId;
  const execute=(command:string[],options:{timeout?:number}={})=>run(command,{...options,signal});
  let disposed=false;
  const dispose=async()=>{
    try{await containers.remove(reviewId);disposed=true;await save(join(output,'container-disposed.json'),{reviewId,at:new Date().toISOString()});}
    catch(error){throw new TerminalRegradeCleanupError('Recheck container cleanup was not confirmed: '+String(error).slice(-1200));}
  };
  try{
    await save(join(output,'container.json'),{reviewId,container,context:config.context});
    await save(join(output,'environment.json'),binding);
    const staging=join(output,'worker');await bundle.writeTo(staging);
    await execute(docker('exec',container,'mkdir','-p','/opt/hicode-eval',remote+'/project'));
    await execute(docker('cp',staging+'/.',container+':/opt/hicode-eval/'));
    await execute(docker('cp',join(config.payload,'source.tar.gz'),container+':/opt/hicode-eval/source.tar.gz'));
    await execute(docker('exec',container,'python3','/opt/hicode-eval/bootstrap.py','/opt/hicode-eval/source.tar.gz',release.split('/').at(-1)!),{timeout:660000});
    if(deep){
      const head=await execute(docker('exec',container,'git','-C','/app','rev-parse','HEAD'));
      if(head!==z.object({baseCommit:z.string().regex(/^[a-f0-9]{40}$/)}).parse(plan.job.deep).baseCommit)throw Error('Prepared DeepSWE baseline changed');
      await execute(docker('exec',container,'cp','-a','/app',remote+'/baseline'),{timeout:120000});
      await execute(docker('exec',container,'chmod','700',remote+'/baseline'));
    }
    await execute(docker('cp',project+'/.',container+':'+remote+'/project/'));
    if(!isDeepStrictEqual(await runEvidenceTree(project),expected))throw Error('Answer changed while staging');
    await save(join(output,'job.json'),{...oldJob,...plan.job,release,network:state.network,verifierSeconds:plan.verifierSeconds});
    for(const name of ['job.json','input.json',...(pathMap?['evidence-paths.json']:[]),...(script?['service-restart.sh']:['completion-events.jsonl'])])await execute(docker('cp',join(output,name),container+':'+remote+'/'+name));
    if(snapshotBytes)await execute(docker('cp',snapshot,container+':'+remote+'/service-system.tar'));
    await execute(docker('cp',join(taskRoot,'tests'),container+':'+remote+'/tests'));
    await execute(docker('exec',container,'python3','/opt/hicode-eval/terminal_regrade.py',remote),{timeout:(plan.verifierSeconds+240)*1000});
    for(const name of ['result.json','logs',...(deep?['artifacts','patch-manifest.json']:[])])await execute(docker('cp',container+':'+remote+'/'+name,join(output,name)));
    const result=await readJson(join(output,'result.json'),terminalRegradeResultSchema);
    if(result.runId!==state.id||result.reviewId!==reviewId||result.projectSha256!==input.projectSha256||(snapshotBytes?(!('snapshotSha256' in result)||result.snapshotSha256!==digest(snapshotBytes)):(!('kind' in result)||result.kind!=='ordinary')))
      throw Error('Service recheck identity mismatch');
    if((snapshotBytes&&digest(await readFile(snapshot))!==digest(snapshotBytes))||!isDeepStrictEqual(await runEvidenceTree(project),expected))throw Error('Original evidence changed during recheck');
    await save(join(output,'collection.json'),{complete:true,files:await runEvidenceTree(join(output,'logs'))});
    await dispose();
    return result;
  }finally{if(!disposed)await dispose();}
}

export function terminalRegradeChanges(result:TerminalRegradeResult):Pick<Run,'state'|'grading'|'reward'|'note'>|undefined{
  if(result.grading==='unavailable')return undefined;
  return {state:result.grading,grading:result.grading,reward:result.grading==='passed'?1:0,note:'Original verifier recheck '+result.reviewId+'; no model calls'};
}
