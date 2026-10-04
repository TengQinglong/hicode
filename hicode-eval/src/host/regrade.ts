import {constants} from 'node:fs';
import {open, mkdir, realpath, writeFile} from 'node:fs/promises';
import {join,dirname,resolve} from 'node:path';
import {createHash, randomBytes} from 'node:crypto';
import {z} from 'zod';
import {LinuxMachine} from './linux.js';
import {configSchema, runSchema, done,idSchema,regradeResultSchema} from './types.js';
import type {Run} from './types.js';
import {validateFrozenSweTask} from './sweTasks.js';
import {readJson, save} from './store.js';
import {lease} from './lease.js';

const patchManifestSchema = z.object({sha256:z.string().regex(/^[a-f0-9]{64}$/), baseCommit:z.string(), baselineCommit:z.string(), revision:z.string(), method:z.literal('host-owned-tree-diff')}).strict();
const predictionSchema = z.object({instance_id:z.string(), model_name_or_path:z.string(), model_patch:z.string()}).strict();
const verifierProxySchema = z.string().max(2048).url().refine(value => {
  const url = new URL(value);
  return !/[\s\x00-\x1f\x7f]/.test(value) && ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password &&
    url.pathname === '/' && !url.search && !url.hash;
}, 'Verifier proxy must be an HTTP(S) origin without credentials');
export interface RegradeInput {
  version:1;runId:string;reviewId:string;instanceId:string;baseCommit:string;patchSha256:string;
  originalExecution:Run['execution'];originalGrading:Run['grading'];createdAt:string;
  verifierProxy:string|null;
}

export async function regradeRun(data: string, runId: string, verifierProxy?: string) {
  idSchema.parse(runId);
  const proxy = verifierProxy === undefined ? null : verifierProxySchema.parse(verifierProxy);
  const release = await lease(data, 'regrade');
  try {
    const config = await readJson(join(data,'config.json'),configSchema);
    if(config.data!==data)throw Error('Regrade data root differs from the recorded configuration');
    const original = join(data,'runs',runId);
    const state = await readJson(join(original,'state.json'),runSchema);
    if (state.id!==runId || state.dataset!=='swe-bench-verified' || !done(state.state) || state.state==='needs_recovery' || state.execution==='pending' || state.collection!=='complete') throw Error('Regrade requires a finished, fully collected SWE run');
    if (state.task.includes('/') || state.task.includes('..')) throw Error('Invalid task identity');
    const taskRoot = join(original,'task',state.task);
    const task = await validateFrozenSweTask(state.task,taskRoot);
    const evidence = join(original,'evidence');
    const manifest = await readJson(join(evidence,'patch-manifest.json'),patchManifestSchema);
    const prediction = await readJson(join(evidence,'prediction.json'),predictionSchema,8*1024*1024);
    let patchPath=join(evidence,'tests/model.patch');
    if(await realpath(dirname(patchPath))!==resolve(dirname(patchPath)))throw Error('Symlinked archived patch directory');
    let patch:Buffer;
    let predictionOnly = false;
    const fd = await open(patchPath,constants.O_RDONLY|constants.O_NOFOLLOW).catch((error: NodeJS.ErrnoException) => {
      if(error.code !== 'ENOENT')throw error;
      predictionOnly = true;
      return undefined;
    });
    if(fd){
      try {
        const stat = await fd.stat(); if(!stat.isFile()||stat.size>8*1024*1024)throw Error('Invalid archived patch size/type');
        patch = await fd.readFile();
      } finally {await fd.close();}
    } else patch=Buffer.from(prediction.model_patch,'utf8');
    if(patch.length>8*1024*1024)throw Error('Invalid archived patch size/type');
    const sha256 = createHash('sha256').update(patch).digest('hex');
    if (sha256!==manifest.sha256 || sha256!==createHash('sha256').update(prediction.model_patch).digest('hex') || prediction.instance_id!==task.instanceId || manifest.baseCommit!==task.baseCommit || manifest.baselineCommit!==task.baselineCommit || manifest.revision!==task.revision) throw Error('Archived prediction hash or baseline identity mismatch');
    const reviewId = randomBytes(8).toString('hex');
    const output = join(original,'rechecks',reviewId); await mkdir(output,{recursive:true,mode:0o700});
    // A verifier setup failure can occur after sealing prediction.json but before
    // model.patch is written. Reconstruct only in this independent recheck copy.
    if(predictionOnly){patchPath=join(output,'model.patch');await writeFile(patchPath,patch,{mode:0o600});}
    const input:RegradeInput = {version:1,runId,reviewId,instanceId:task.instanceId,baseCommit:task.baseCommit,patchSha256:sha256,originalExecution:state.execution,originalGrading:state.grading,createdAt:new Date().toISOString(),verifierProxy:proxy};
    await save(join(output,'input.json'),input);
    const machine = new LinuxMachine(config);
    await machine.regrade(runId,reviewId,taskRoot,patchPath,task,input,output);
    const result = await readJson(join(output,'result.json'),regradeResultSchema);
    if(result.runId!==runId||result.instanceId!==task.instanceId||result.patchSha256!==sha256||result.originalExecution!==state.execution)throw Error('Regrade result identity mismatch');
    return {...result,reviewId,evidencePath:output};
  } finally {await release();}
}
