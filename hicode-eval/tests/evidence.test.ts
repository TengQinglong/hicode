import {test, expect, spyOn} from 'bun:test';
import {mkdtemp, writeFile, symlink, rm, readFile, mkdir, chmod, realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {evidenceTree, tree} from '../src/host/store.js';

test('evidence records dangling, external and cyclic links without reading their targets; sources reject links', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hicode-evidence-'));
  try {
    await writeFile(join(root, 'actual'), 'kept');
    await symlink('/app/sqlite/sqlite3', join(root, 'sqlite3'));
    await symlink('/etc/passwd', join(root, 'external'));
    await symlink('.', join(root, 'cycle'));
    const snapshot = await evidenceTree(root);
    expect(snapshot['sqlite3']!.symlink).toBe('/app/sqlite/sqlite3');
    expect(snapshot['external']!.bytes).toBe('/etc/passwd'.length);
    expect(snapshot['cycle']!.symlink).toBe('.');
    expect(Object.keys(snapshot)).toHaveLength(4);
    expect(await readFile(join(root, 'actual'), 'utf8')).toBe('kept');
    await expect(tree(root)).rejects.toThrow('Symlink');
  } finally {await rm(root, {recursive:true, force:true});}
});


// Real execute/collection control flow, with only Docker transport and dataset validation replaced.
// The fake runner emits sealed packets; no Linux machine, network, user state or model is used.
test.each([false,true])('collection errors do not cancel solving or erase confirmed facts (finalFailure=%s)', async finalFailure => {
  const {createHash}=await import('node:crypto');
  const {LinuxMachine,EvidenceCollectionError}=await import('../src/host/linux.js');
  const {configSchema,runSchema}=await import('../src/host/types.js');
  const transport=await import('../src/host/store.js');
  const adapters=await import('../src/host/publicTasks.js');
  const root=await realpath(await mkdtemp(join(tmpdir(),'hicode-evidence-flow-')));
  const payload=join(root,'payload'),path=join(root,'run'),tools=join(root,'tools');
  await mkdir(payload);await mkdir(tools);await mkdir(join(path,'task','fixture'),{recursive:true});
  const archive=Buffer.from('offline source fixture'),hash=createHash('sha256').update(archive).digest('hex');
  await writeFile(join(payload,'source.tar.gz'),archive);
  await transport.save(join(payload,'manifest.json'),{files:{'source.tar.gz':hash}});
  await writeFile(join(path,'task','fixture','task.toml'),'[agent]\ntimeout_sec=30\n[verifier]\ntimeout_sec=30\n');
  await writeFile(join(tools,'docker'),`#!/bin/sh
printf '%s\n' '{"type":"phase","phase":"Running HiCode"}'
sleep 0.01
printf '%s\n' '{"type":"result","execution":"completed","grading":"passed","uid":20001}'
`);
  await chmod(join(tools,'docker'),0o700);
  const config=configSchema.parse({version:3,data:root,tasks:join(root,'tasks'),payload,context:'fixture',machine:'fixture-machine',concurrency:1,budget:{},model:{source:'qwen',model:'fixture',apiKeyEnv:'FIXTURE_KEY',baseUrl:'http://127.0.0.1:1'}});
  const state=runSchema.parse({version:2,id:'0123456789abcdef',batchId:'fedcba9876543210',task:'fixture',state:'preparing',createdAt:1,updatedAt:1,model:'fixture',budget:{}});
  const calls:string[][]=[];let copies=0;
  const run=spyOn(transport,'run').mockImplementation(async command => {
    calls.push(command);
    if(command.includes('inspect'))return JSON.stringify([{State:{Running:true},Config:{Labels:{'dev.hicode.role':'eval'}}}]);
    if(command.includes('/opt/hicode-eval/bootstrap.py'))return '/opt/hicode/releases/'+hash;
    if(command.includes('fixture-machine:/eval/runs/'+state.id+'/.')){
      copies++;
      if(copies===1||finalFailure)throw Error('temporary snapshot transport failure');
      const stage=command.at(-1)!;
      await writeFile(join(stage,'result.json'),JSON.stringify({execution:'completed',grading:'passed'}));
      await symlink('/app/sqlite/sqlite3',join(stage,'sqlite3'));
    }
    return '';
  });
  const validate=spyOn(adapters,'validatePublicTask').mockResolvedValue({hashes:{},inputs:[],initializer:null,directories:[],packages:[],verifierPackages:[],verifierPrelude:'none',verifierRootOverlay:false,commands:[],environment:{},verifierEnvironment:{}});
  const oldPath=process.env.PATH;
  // Advance the collection clock instead of spending 30 seconds on every regression.
  const now=Date.now();let clock=0;const time=spyOn(Date,'now').mockImplementation(()=>now+(clock++)*31000);
  process.env.PATH=tools+':'+oldPath;
  try {
    const machine=new LinuxMachine(config);await machine.prepare();
    const executing=machine.execute(state,path,'fixture-secret',async()=>{});
    if(finalFailure){
      try {await executing;throw Error('Expected evidence export failure');}
      catch(error){
        expect(error).toBeInstanceOf(EvidenceCollectionError);
        if(!(error instanceof EvidenceCollectionError))throw error;
        expect(error.result).toMatchObject({execution:'completed',grading:'passed'});
      }
    }else{
      expect(await executing).toMatchObject({execution:'completed',grading:'passed'});
      const receipt=JSON.parse(await readFile(join(path,'collection.json'),'utf8'));
      expect(receipt.files.sqlite3.symlink).toBe('/app/sqlite/sqlite3');
    }
    expect(copies).toBeGreaterThanOrEqual(2);
    expect(await readFile(join(path,'collection-error.txt'),'utf8')).toContain('snapshot transport failure');
    expect(calls.some(command=>command.some(arg=>arg.includes('/cancel')))).toBe(false);
  }finally{
    if(oldPath===undefined)delete process.env.PATH;else process.env.PATH=oldPath;
    time.mockRestore();run.mockRestore();validate.mockRestore();await rm(root,{recursive:true,force:true});
  }
});
