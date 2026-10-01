import {expect,test} from 'bun:test';
import {mkdtemp,mkdir,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {tree,save} from '../src/host/store.js';
import {validateSweTask,sweCatalog,sweTaskSchema} from '../src/host/sweTasks.js';
import {Lab} from '../src/host/manager.js';
import {configSchema} from '../src/host/types.js';

test('SWE bundles freeze original identity and split public code from private grading data',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'hicode-swe-task-'))),id='django__django-15731',task=join(root,id);
 try {
  await mkdir(join(task,'repository'),{recursive:true});await mkdir(join(task,'hidden'));
  await writeFile(join(task,'repository/example.py'),'public code');await writeFile(join(task,'instruction.md'),'public problem');
  await writeFile(join(task,'hidden/evaluation.json'),'hidden tests');
  const files=Object.fromEntries(Object.entries(await tree(task)).map(([name,file])=>[name,file.sha256]));
  const descriptor={kind:'swe-bench-verified',instanceId:id,revision:'c'.repeat(40),repo:'django/django',version:'4.2',baseCommit:'a'.repeat(40),harnessVersion:'4.1.0',environment:'/opt/hicode-swe/cache/'+'a'.repeat(64),python:'3.9',verifierSeconds:1800,baselineCommit:'b'.repeat(40),files,evaluationMode:'shared-linux-development'};
  await save(join(task,'swe-task.json'),descriptor);
  expect((await sweCatalog(root))[0]?.id).toBe(id);expect((await validateSweTask(id,task)).baseCommit).toBe('a'.repeat(40));
  await expect(validateSweTask('django__django-99999',task)).rejects.toThrow('identity');
  expect(()=>sweTaskSchema.parse({...descriptor,harnessVersion:'5.0.2'})).toThrow();
  const terminal=join(root,'terminal');await mkdir(terminal);
  const payload=join(root,'payload');await mkdir(payload);await save(join(payload,'manifest.json'),{});
  const config=configSchema.parse({version:3,data:join(root,'data'),tasks:terminal,sweTasks:root,payload,context:'unused',machine:'eval',concurrency:2,budget:{},model:{source:'qwen',model:'fixture',apiKeyEnv:'TEST_KEY',baseUrl:'https://example.com'}});
  // root now also contains helper dirs; restrict catalog to its intended registry.
  const registry=join(root,'registry');await mkdir(registry);
  const {rename,symlink}=await import('node:fs/promises');await rename(task,join(registry,id));config.sweTasks=registry;
  await symlink('/etc/passwd',join(registry,id,'repository/escape'));
  await expect(validateSweTask(id,join(registry,id))).rejects.toThrow('escapes');
  await rm(join(registry,id,'repository/escape'));
  const lab=new Lab(config,'unused');await lab.init();
  const batch=await lab.submit({name:'SWE pilot',tasks:[{id,agentSeconds:1800}],concurrency:2});
  expect(lab.runs.get(batch.runIds[0]!)?.dataset).toBe('swe-bench-verified');
  await lab.close();
  await writeFile(join(registry,id,'instruction.md'),'changed problem');
  await expect(validateSweTask(id,join(registry,id))).rejects.toThrow('snapshot');
 }finally{await rm(root,{recursive:true,force:true});}
});

test('mixed submission under CLI umask preserves links and executable bits and runs at concurrency five',async()=>{
 const {spyOn}=await import('bun:test');
 const {symlink,chmod}=await import('node:fs/promises');
 const {LinuxMachine}=await import('../src/host/linux.js');
 const adapters=await import('../src/host/publicTasks.js');
 const {datasetTree}=await import('../src/host/sweTasks.js');
 const root=await realpath(await mkdtemp(join(tmpdir(),'hicode-mixed-submit-')));
 const prior=process.umask(0o077);
 const prepare=spyOn(LinuxMachine.prototype,'prepare').mockResolvedValue(undefined);
 const validate=spyOn(adapters,'validatePublicTask').mockResolvedValue({hashes:{},inputs:[],initializer:null,directories:[],packages:[],verifierPackages:[],verifierPrelude:'none',publicTestInputs:[],verifierChroot:false,verifierRootOverlay:false,commands:[],environment:{},verifierEnvironment:{}});
 let release=()=>{};const gate=new Promise<void>(resolve=>{release=resolve;});let active=0,peak=0;
 const execute=spyOn(LinuxMachine.prototype,'execute').mockImplementation(async()=>{
  peak=Math.max(peak,++active);await gate;active--;return {type:'result',execution:'completed',grading:'passed',uid:20001};
 });
 let lab:Lab|undefined;
 try {
  const terminal=join(root,'terminal'),registry=join(root,'swe'),payload=join(root,'payload');
  await mkdir(terminal);await mkdir(registry);await mkdir(payload);await save(join(payload,'manifest.json'),{});
  const ids=['django__django-14725','django__django-14787','django__django-15863','django__django-16136'];
  for(const id of ids){
   const task=join(registry,id);await mkdir(join(task,'repository'),{recursive:true});await mkdir(join(task,'hidden'));
   await writeFile(join(task,'repository/script'),'#!/bin/sh\nexit 0\n');await chmod(join(task,'repository/script'),0o755);
   await writeFile(join(task,'instruction.md'),'Public problem');await writeFile(join(task,'hidden/evaluation.json'),'Private fixture');
   await symlink('script',join(task,'repository/link'));
   const files=Object.fromEntries(Object.entries(await datasetTree(task,'swe-bench-verified')).map(([path,file])=>[path,file.sha256]));
   await save(join(task,'swe-task.json'),{kind:'swe-bench-verified',instanceId:id,revision:'c'.repeat(40),repo:'django/django',version:id.startsWith('django__django-147')?'4.1':'4.2',baseCommit:'a'.repeat(40),harnessVersion:'4.1.0',environment:'/opt/hicode-swe/cache/'+'a'.repeat(64),python:'3.9',verifierSeconds:1800,baselineCommit:'b'.repeat(40),files,evaluationMode:'shared-linux-development'});
  }
  for(const id of ['regex-log','cancel-async-tasks']){
   await mkdir(join(terminal,id));await writeFile(join(terminal,id,'task.toml'),'[agent]\ntimeout_sec=900\n[verifier]\ntimeout_sec=900\n');
  }
  const config=configSchema.parse({version:3,data:join(root,'data'),tasks:terminal,sweTasks:registry,payload,context:'unused',machine:'fixture',concurrency:5,budget:{},model:{source:'qwen',model:'fixture',apiKeyEnv:'TEST_KEY',baseUrl:'https://example.com'}});
  lab=new Lab(config,'fixture');await lab.init();await lab.prepareMachine();
  const batch=await lab.submit({name:'mixed freeze',concurrency:5,tasks:['regex-log',...ids,'cancel-async-tasks'].map(id=>({id,agentSeconds:3600}))});
  for(let i=0;i<100&&execute.mock.calls.length<5;i++)await Bun.sleep(5);
  expect(execute).toHaveBeenCalledTimes(5);expect(peak).toBe(5);expect(batch.runIds).toHaveLength(6);
  const frozen=await datasetTree(join(lab.path(batch.runIds[1]!),'task',ids[0]),'swe-bench-verified');
  expect(frozen).toEqual(await datasetTree(join(registry,ids[0]),'swe-bench-verified'));
  release();
  for(let i=0;i<100&&batch.runIds.some(id=>lab!.runs.get(id)?.state!=='passed');i++)await Bun.sleep(5);
  expect(execute).toHaveBeenCalledTimes(6);expect(peak).toBe(5);
  expect(batch.runIds.every(id=>lab!.runs.get(id)?.state==='passed')).toBe(true);
 }finally{release();await lab?.close();process.umask(prior);prepare.mockRestore();validate.mockRestore();execute.mockRestore();await rm(root,{recursive:true,force:true});}
});

test('SWE version contract accepts only reviewed repository versions',()=>{
 expect(sweTaskSchema.shape.version.parse('4.0')).toBe('4.0');
 expect(sweTaskSchema.shape.version.parse('4.1')).toBe('4.1');
 expect(sweTaskSchema.shape.version.parse('4.2')).toBe('4.2');
 expect(sweTaskSchema.shape.version.parse('5.0')).toBe('5.0');
 for(const version of ['1.0','1.1','1.4','1.5','1.6','1.7','1.8','1.9','1.10','1.11','1.12','0.12','5.1','5.2','5.4','6.0','6.2','7.2','2022.03','2022.06','2022.09'] as const)expect(sweTaskSchema.shape.version.parse(version)).toBe(version);
 expect(sweTaskSchema.shape.python.parse('3.8')).toBe('3.8');
 expect(sweTaskSchema.shape.python.parse('3.11')).toBe('3.11');
 expect(sweTaskSchema.shape.python.parse('3.10')).toBe('3.10');
 expect(sweTaskSchema.shape.version.safeParse('5.3').success).toBe(false);
 expect(sweTaskSchema.shape.version.safeParse('1.2').success).toBe(false);
});

test('Django 5.0 requires Python 3.11 before catalog or submission',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'hicode-swe-python-')));
 const id='django__django-16485',task=join(root,id);
 try {
  await mkdir(task);
  const descriptor={kind:'swe-bench-verified',instanceId:id,revision:'c'.repeat(40),repo:'django/django',version:'5.0',baseCommit:'a'.repeat(40),harnessVersion:'4.1.0',environment:'/opt/hicode-swe/cache/'+'a'.repeat(64),python:'3.9',verifierSeconds:1800,baselineCommit:'b'.repeat(40),files:{},evaluationMode:'shared-linux-development'};
  await save(join(task,'swe-task.json'),descriptor);
  await expect(sweCatalog(root)).rejects.toThrow('supported repository environment');
  await expect(validateSweTask(id,task)).rejects.toThrow('supported repository environment');
  await save(join(task,'swe-task.json'),{...descriptor,python:'3.11'});
  expect((await sweCatalog(root)).map(entry=>entry.id)).toEqual([id]);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('SWE catalog ties each repository identity to its original Python version',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'hicode-swe-repos-')));
 try {
  const base={kind:'swe-bench-verified',revision:'c'.repeat(40),baseCommit:'a'.repeat(40),harnessVersion:'4.1.0',
   environment:'/opt/hicode-swe/cache/'+'a'.repeat(64),verifierSeconds:1800,baselineCommit:'b'.repeat(40),
   files:{},evaluationMode:'shared-linux-development'};
  const django='django__django-14007',sympy='sympy__sympy-12345',pytest='pytest-dev__pytest-10081',xarray='pydata__xarray-3095';
  for(const id of [django,sympy,pytest,xarray])await mkdir(join(root,id));
  await save(join(root,django,'swe-task.json'),{...base,instanceId:django,repo:'django/django',version:'4.0',python:'3.8'});
  await save(join(root,sympy,'swe-task.json'),{...base,instanceId:sympy,repo:'sympy/sympy',version:'1.4',python:'3.9'});
  await save(join(root,pytest,'swe-task.json'),{...base,instanceId:pytest,repo:'pytest-dev/pytest',version:'7.2',python:'3.9'});
  await save(join(root,xarray,'swe-task.json'),{...base,instanceId:xarray,repo:'pydata/xarray',version:'2022.09',python:'3.10'});
  expect((await sweCatalog(root)).map(entry=>entry.id).sort()).toEqual([django,pytest,sympy,xarray].sort());
  await save(join(root,xarray,'swe-task.json'),{...base,instanceId:xarray,repo:'pydata/xarray',version:'2022.09',python:'3.9'});
  await expect(sweCatalog(root)).rejects.toThrow('supported repository environment');
  await save(join(root,xarray,'swe-task.json'),{...base,instanceId:xarray,repo:'pydata/xarray',version:'2022.09',python:'3.10'});
  await save(join(root,sympy,'swe-task.json'),{...base,instanceId:sympy,repo:'sympy/sympy',version:'4.0',python:'3.8'});
  await expect(sweCatalog(root)).rejects.toThrow('supported repository environment');
  await save(join(root,sympy,'swe-task.json'),{...base,instanceId:sympy,repo:'django/django',version:'4.0',python:'3.8'});
  await expect(sweCatalog(root)).rejects.toThrow('supported repository environment');
 }finally{await rm(root,{recursive:true,force:true});}
});
