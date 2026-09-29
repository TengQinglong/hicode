#!/usr/bin/env bun
import { parseArgs } from 'node:util';
import { resolve, join } from 'node:path';
import { realpath } from 'node:fs/promises';
import { parse } from 'dotenv';
import { z } from 'zod';
import { ROOT, Lab } from './lib/manager.js';
import { Client } from './lib/client.js';
import { configSchema, modelSchema, submissionSchema, idSchema } from './lib/types.js';
import { directory, readJson, run, save, exists } from './lib/store.js';
import { lease } from './lib/lease.js';
import { serve } from './lib/server.js';
async function main() {
  process.umask(0o077);
  const { positionals, values: v } = parseArgs({ allowPositionals: true, options: {
    'data-dir': { type: 'string' }, tasks: { type: 'string' }, payload: { type: 'string' }, 'docker-context': { type: 'string', default: 'colima-hicode' }, machine: { type: 'string', default: 'hicode-eval-linux' }, concurrency: { type: 'string', default: '2' }, port: { type: 'string', default: '8878' }, file: { type: 'string' }, run: { type: 'string' }, batch: { type: 'string' }, 'wait-seconds': { type: 'string', default: '30' }, source: { type: 'string' }, model: { type: 'string' }, 'model-config': { type: 'string' }, 'snapshot-worktree': { type: 'boolean' }, help: { type: 'boolean' }
  } });
  const command = positionals[0];
  if (v.help || !command) { console.log('HiCode Eval · persistent Linux\n  serve --data-dir DIR --payload DIR --tasks DIR [--machine hicode-eval-linux]\n  prepare --payload DIR [--snapshot-worktree]\n  catalog | submit --file batch.json | status [--batch ID]\n  wait --batch ID [--wait-seconds 30] | cancel --batch ID | resume --batch ID | recover --run ID | report --batch ID --file report.md'); return; }
  if (positionals.length !== 1 || !['serve','prepare','catalog','submit','status','wait','cancel','resume','recover','report'].includes(command)) throw Error('Unknown command');
  const required = (key: keyof typeof v) => { const value = v[key]; if (typeof value !== 'string' || !value) throw Error('Missing --' + key); return value; };
  const port = z.number().int().min(1024).max(65535).parse(Number(v.port));
  if (command === 'prepare') {
    console.log(await run(['python3',join(ROOT,'container/prepare.py'),'--source',resolve(ROOT,'..'),'--payload',resolve(required('payload')),...(v['snapshot-worktree']?['--snapshot-worktree']:[])],{timeout:60000}));return;
  }
  if (command !== 'serve') {
    const client = new Client(port), batch = v.batch ? idSchema.parse(v.batch) : undefined;
    let result: unknown;
    if (command === 'catalog') result = (await client.status()).tasks;
    else if (command === 'submit') result = await client.request('submit', await readJson(await realpath(resolve(required('file'))), submissionSchema));
    else if (command === 'recover') result = await client.request('recover-run',{run:idSchema.parse(required('run'))});
    else if (command === 'status') result = await client.status(batch);
    else {
      if (!batch) throw Error('Missing --batch');
      if (command === 'cancel') result = await client.request('cancel-batch',{batch});
      else if (command === 'resume') result = await client.request('resume-batch',{batch});
      else if (command === 'report') { const file=Bun.file(resolve(required('file')));if(file.size>200000)throw Error('Report too large');result=await client.request('report',{batch,text:await file.text()}); }
      else {
        const seconds=z.number().int().min(1).max(60).parse(Number(v['wait-seconds'])),deadline=Date.now()+seconds*1000;
        for (;;) {
          const status=await client.status(batch),b=status.batches[0];
          if(b.state!=='running'||status.schedulingBlocked||Date.now()>=deadline){result={...status,waitOutcome:b.state==='finished'?'finished':status.schedulingBlocked?'blocked':'pending'};break;}
          await Bun.sleep(Math.min(1000,Math.max(0,deadline-Date.now())));
        }
      }
    }
    console.log(JSON.stringify(result,null,2));return;
  }
  const data=await directory(required('data-dir')),release=await lease(data,'service');
  let lab: Lab|undefined,server:ReturnType<typeof serve>|undefined;
  try {
    if(!!v.source!==!!v.model)throw Error('Supply both --source and --model');
    const model=v['model-config']?await readJson(resolve(v['model-config']),modelSchema):modelSchema.parse(JSON.parse(await run(['bun',join(ROOT,'resolve-model.mjs'),resolve(ROOT,'..'),resolve(ROOT,'..'),join(process.env.HOME??'','.hicode'),...(v.source&&v.model?[v.source,v.model]:[])])));
    let credential=process.env[model.apiKeyEnv];
    for(const path of [resolve(ROOT,'../.env'),join(process.env.HOME??'','.hicode/.env')])if(!credential&&await exists(path))credential=parse(await Bun.file(path).text())[model.apiKeyEnv];
    if(!credential)throw Error('Missing provider credential');
    const config=configSchema.parse({version:3,data,tasks:resolve(required('tasks')),payload:resolve(required('payload')),context:v['docker-context'],machine:v.machine,concurrency:Number(v.concurrency),budget:{},model});
    lab=new Lab(config,credential);await lab.init();
    console.log('Checking persistent Linux machine and fixed release…');await lab.prepareMachine();
    server=serve(lab,port);await save(join(data,'config.json'),config);
    let closing=false;const shutdown=async()=>{if(closing)return;closing=true;server?.stop();await lab?.close();await release();process.exit(0);};
    process.on('SIGTERM',()=>{void shutdown();});process.on('SIGINT',()=>{void shutdown();});
    console.log(`HiCode Eval: http://127.0.0.1:${port}\nMachine: ${config.machine} · Concurrency: ${config.concurrency} · Task-local dependencies only`);
  } catch(error){server?.stop();await lab?.close();await release();throw error;}
}
main().catch(error=>{console.error(error instanceof Error?error.message:'Evaluation failed');process.exitCode=1;});
