import {test,expect} from 'bun:test';
import {mkdtemp,mkdir,writeFile,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {validateDeepTask,deepExecution} from '../src/host/deepTasks.js';
import {tree,save} from '../src/host/store.js';
import {runSchema} from '../src/host/types.js';

test('original abbreviated baselines retain their original input while execution freezes the full commit',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'deep-reference-'))),source=join(root,'task'),definition=join(root,'definition.json');await mkdir(source);
 const commit='a'.repeat(40),ref=commit.slice(0,7),image='public.ecr.aws/d3j8x8q7/swe-bench-202605:fixture-v1.1';
 const original=`schema_version="1.3"\n[metadata]\ntask_id="fixture"\nrepository_url="https://github.com/example/project"\nbase_commit_hash="${ref}"\n[agent]\nnetwork_mode="no-network"\ntimeout_sec=10800\n[environment]\ndocker_image="${image}"\nmemory_mb=8192\ngpus=0\n[verifier]\nnetwork_mode="no-network"\nenvironment_mode="separate"\ntimeout_sec=1800\n[[verifier.collect]]\ncommand="cd /app && mkdir -p /logs/artifacts && git config --global --add safe.directory /app && git diff --binary ${ref} HEAD > /logs/artifacts/model.patch"\ntimeout_sec=300\n`;
 try{
  await writeFile(join(source,'task.toml'),original);
  const profile={repository:'https://github.com/example/project',baseCommit:commit,declaredBaseCommit:ref,declaredImage:image,image:'public.ecr.aws/d3j8x8q7/swe-bench-202605@sha256:'+'b'.repeat(64),architecture:'amd64',agentSeconds:10800,verifierSeconds:1800,hashes:Object.fromEntries(Object.entries(await tree(source)).map(([name,file])=>[name,file.sha256])),runtimeEnvironment:{POLARS_FORCE_PKG:'compat'}};
  await save(definition,{fixture:profile});expect((await validateDeepTask('fixture',source,definition)).baseCommit).toBe(commit);
  const state=runSchema.parse({version:1,id:'a'.repeat(16),batchId:'b'.repeat(16),task:'fixture',dataset:'deep-swe',network:'isolated',state:'queued',createdAt:1,updatedAt:1,model:'offline',budget:{}});
  expect((await deepExecution(state,source,definition)).job.deep).toMatchObject({baseCommit:commit,runtimeEnvironment:{POLARS_FORCE_PKG:'compat'}});
  await save(definition,{fixture:{...profile,runtimeEnvironment:{POLARS_FORCE_PKG:'auto'}}});await expect(validateDeepTask('fixture',source,definition)).rejects.toThrow();
  await save(definition,{fixture:{...profile,baseCommit:'c'.repeat(40)}});await expect(validateDeepTask('fixture',source,definition)).rejects.toThrow('prefix');
  await save(definition,{fixture:{...profile,declaredBaseCommit:commit.slice(0,8)}});await expect(validateDeepTask('fixture',source,definition)).rejects.toThrow();
 }finally{await rm(root,{recursive:true,force:true});}
});
