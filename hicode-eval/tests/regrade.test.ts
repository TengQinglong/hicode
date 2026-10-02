import {test,expect,spyOn} from 'bun:test';
import {mkdtemp,mkdir,writeFile,readFile,rm,realpath,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {regradeRun} from '../src/host/regrade.js';
import {LinuxMachine} from '../src/host/linux.js';
import * as leases from '../src/host/lease.js';
import {save,tree} from '../src/host/store.js';

async function fixture(){
 const data=await realpath(await mkdtemp(join(tmpdir(),'hicode-regrade-'))),run='a'.repeat(16),id='django__django-16877',original=join(data,'runs',run),task=join(original,'task',id),evidence=join(original,'evidence');
 await mkdir(join(task,'repository'),{recursive:true});await mkdir(join(task,'hidden'));await mkdir(join(evidence,'tests'),{recursive:true});
 await writeFile(join(task,'repository/production.py'),'original');await writeFile(join(task,'instruction.md'),'public');await writeFile(join(task,'hidden/evaluation.json'),'private tests');
 const files=Object.fromEntries(Object.entries(await tree(task)).map(([p,f])=>[p,f.sha256]));
 const descriptor={kind:'swe-bench-verified',instanceId:id,revision:'c'.repeat(40),repo:'django/django',version:'4.2',baseCommit:'a'.repeat(40),harnessVersion:'4.1.0',environment:'/opt/hicode-swe/cache/'+'a'.repeat(64),python:'3.9',verifierSeconds:1800,baselineCommit:'b'.repeat(40),files,evaluationMode:'shared-linux-development'};
 await save(join(task,'swe-task.json'),descriptor);
 const state={version:2,id:run,batchId:'b'.repeat(16),task:id,dataset:'swe-bench-verified',state:'failed',createdAt:1,updatedAt:2,model:'fixture',budget:{agentSeconds:2700},execution:'completed',grading:'failed',collection:'complete'};
 await save(join(original,'state.json'),state);
 const model={source:'qwen',model:'fixture',apiKeyEnv:'UNREAD_KEY',baseUrl:'https://offline.invalid/v1'};
 await save(join(data,'config.json'),{version:3,data,tasks:join(data,'tasks'),payload:join(data,'payload'),context:'fixture',machine:'fixture',concurrency:5,budget:{agentSeconds:2700},model});
 const patch='sealed model patch\n',sha256=createHash('sha256').update(patch).digest('hex');await writeFile(join(evidence,'tests/model.patch'),patch);
 await save(join(evidence,'patch-manifest.json'),{sha256,baseCommit:descriptor.baseCommit,baselineCommit:descriptor.baselineCommit,revision:descriptor.revision,method:'host-owned-tree-diff'});
 await save(join(evidence,'prediction.json'),{instance_id:id,model_name_or_path:'fixture',model_patch:patch});
 return {data,run,id,original,task,evidence,patch,sha256};
}

test('regrade validates a sealed prediction and stores separate evidence without changing the original score or patch',async()=>{
 const f=await fixture();const lock=spyOn(leases,'lease').mockResolvedValue(async()=>{});
 const execute=spyOn(LinuxMachine.prototype,'regrade').mockImplementation(async(run,review,task,patch,inputTask,input,output)=>{
  expect(run).toBe(f.run);expect(review).toMatch(/^[a-f0-9]{16}$/);expect(task).toBe(f.task);
  expect(inputTask.instanceId).toBe(f.id);expect(input.patchSha256).toBe(f.sha256);expect(await readFile(patch,'utf8')).toBe(f.patch);
  await save(join(output,'result.json'),{version:1,runId:run,instanceId:f.id,patchSha256:f.sha256,grading:'passed',reason:'original tests executed',originalExecution:'completed',modelCalls:0});
 });
 try{
  const before=await readFile(join(f.original,'state.json'),'utf8');const result=await regradeRun(f.data,f.run);
  expect(result.grading).toBe('passed');expect(result.modelCalls).toBe(0);expect(result.evidencePath).toContain('/rechecks/');expect(execute).toHaveBeenCalledTimes(1);
  expect(await readFile(join(f.original,'state.json'),'utf8')).toBe(before);expect(await readFile(join(f.evidence,'tests/model.patch'),'utf8')).toBe(f.patch);
 }finally{lock.mockRestore();execute.mockRestore();await rm(f.data,{recursive:true,force:true});}
});

test('corrupted or redirected archived patches fail before Linux grading',async()=>{
 const f=await fixture();const lock=spyOn(leases,'lease').mockResolvedValue(async()=>{});const execute=spyOn(LinuxMachine.prototype,'regrade').mockRejectedValue(Error('Must not execute'));
 try{
  await writeFile(join(f.evidence,'tests/model.patch'),'tampered');await expect(regradeRun(f.data,f.run)).rejects.toThrow('hash');
  await rm(join(f.evidence,'tests'),{recursive:true});await symlink(f.task,join(f.evidence,'tests'));await expect(regradeRun(f.data,f.run)).rejects.toThrow('Symlinked');
  expect(execute).not.toHaveBeenCalled();
 }finally{lock.mockRestore();execute.mockRestore();await rm(f.data,{recursive:true,force:true});}
});
