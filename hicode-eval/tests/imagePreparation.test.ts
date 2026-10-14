import {test,expect,spyOn} from 'bun:test';
import {mkdtemp,mkdir,realpath,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {EvalLayout} from '../src/host/layout.js';
import {EnvironmentStore} from '../src/host/environments.js';
import {save,tree} from '../src/host/store.js';
import * as transport from '../src/host/store.js';
import type {CatalogTask} from '../src/host/catalog.js';

test('official image tasks build and freeze reviewed preparation scripts as their own layer',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'image-preparation-'))),layout=new EvalLayout(root);await layout.initialize();
 const task:CatalogTask={dataset:'deep-swe',id:'fixture',source:layout.source({dataset:'deep-swe',id:'fixture'}),status:'untested',environment:'unprepared',results:[]};
 const source=task.source!,preparation=join(layout.preparations,'deep-swe','fixture');await mkdir(source,{recursive:true});await mkdir(preparation,{recursive:true});
 const commit='a'.repeat(40),tag='public.ecr.aws/d3j8x8q7/swe-bench-202605:fixture-v1.1',ref='public.ecr.aws/d3j8x8q7/swe-bench-202605@sha256:'+'b'.repeat(64);
 await writeFile(join(source,'task.toml'),`schema_version="1.3"\n[metadata]\ntask_id="fixture"\nrepository_url="https://github.com/example/project"\nbase_commit_hash="${commit}"\n[agent]\nnetwork_mode="no-network"\ntimeout_sec=10800\n[environment]\ndocker_image="${tag}"\nmemory_mb=8192\ngpus=0\n[verifier]\nnetwork_mode="no-network"\nenvironment_mode="separate"\ntimeout_sec=1800\n[[verifier.collect]]\ncommand="cd /app && mkdir -p /logs/artifacts && git config --global --add safe.directory /app && git diff --binary ${commit} HEAD > /logs/artifacts/model.patch"\ntimeout_sec=300\n`);
 await writeFile(join(preparation,'setup.sh'),'#!/bin/sh\nmkdir -p /opt/hicode-task/cache\n');
 task.preparation={directory:preparation,script:'setup.sh',sha256:createHash('sha256').update(JSON.stringify(await tree(preparation))).digest('hex')};
 await save(layout.definition('deep-swe'),{fixture:{repository:'https://github.com/example/project',baseCommit:commit,declaredImage:tag,image:ref,architecture:'amd64',agentSeconds:10800,verifierSeconds:1800,hashes:Object.fromEntries(Object.entries(await tree(source)).map(([name,file])=>[name,file.sha256])),runtimeEnvironment:{}}});
 await mkdir(layout.runtime);await save(join(layout.runtime,'images.json'),{system:'ubuntu@sha256:'+'c'.repeat(64),python:'python@sha256:'+'d'.repeat(64),bun:'oven/bun@sha256:'+'e'.repeat(64),node:'node@sha256:'+'f'.repeat(64),uv:'ghcr.io/astral-sh/uv@sha256:'+'1'.repeat(64)});await writeFile(layout.runtimeDockerfile('deep-swe'),'FROM {{source}}\nUSER root\n');
 const sourceId='sha256:'+'b'.repeat(64),built=new Map<string,{Id:string;Config:{Labels:Record<string,string>}}>(),files:string[]=[];
 const fake=spyOn(transport,'run').mockImplementation(async argv=>{
  if(argv.includes('{{.Architecture}}'))return 'amd64';
  if(argv.includes('inspect')){const name=argv.at(-1)!;return JSON.stringify([built.get(name)??{Id:sourceId,Config:{Labels:{}}}]);}
  if(argv.includes('build')){
   expect(argv[argv.indexOf('--platform')+1]).toBe('linux/amd64');
   const directory=argv.at(-1)!,dockerfile=await readFile(join(directory,'Dockerfile'),'utf8'),key=dockerfile.match(/dev.hicode.environment="([a-f0-9]+)"/)![1]!,name=argv[argv.indexOf('-t')+1]!;
   const record={Id:'sha256:'+key,Config:{Labels:{'dev.hicode.environment':key}}};built.set(name,record);built.set(record.Id,record);files.push(dockerfile);
   if(dockerfile.includes('COPY preparation'))expect(await readFile(join(directory,'preparation/setup.sh'),'utf8')).toContain('/opt/hicode-task/cache');
  }
  return '';
 });
 try{
  const store=new EnvironmentStore(layout.environments,'offline'),binding=await store.prepareTask(task);
  expect(binding.preparation?.kind).toBe('task');expect(binding.preparation?.parentImage).toBe(binding.dependencies.imageId);
  expect(files.some(file=>file.includes('"/bin/bash","/opt/hicode-task/source/setup.sh"'))).toBe(true);
  expect(await store.resolve(task)).toEqual(binding);
  await writeFile(join(preparation,'setup.sh'),'tampered');await expect(store.prepareTask(task)).rejects.toThrow('frozen recipe');
 }finally{fake.mockRestore();await rm(root,{recursive:true,force:true});}
}, 20000);
