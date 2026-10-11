import {test,expect} from 'bun:test';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {run,exists} from '../src/host/store.js';

test.each(['abort','timeout'] as const)('host %s stops the owned subprocess group, including a child holding output pipes',async mode=>{
 const root=await mkdtemp(join(tmpdir(),'eval-process-')),pidFile=join(root,'child.pid');
 const childProgram='setInterval(()=>{},1000)';
 const program=`const child=Bun.spawn([process.execPath,'-e',${JSON.stringify(childProgram)}],{stdout:'inherit',stderr:'inherit'});await Bun.write(${JSON.stringify(pidFile)},String(child.pid));setInterval(()=>{},1000);`;
 const controller=new AbortController();let childPid:number|undefined;
 try{
  const command=run([process.execPath,'-e',program],{signal:controller.signal,timeout:mode==='timeout'?800:5000});
  const outcome=command.then(()=>null,(error:unknown)=>error);
  const deadline=Date.now()+2000;
  for(;;){
   if(await exists(pidFile)){const value=(await readFile(pidFile,'utf8')).trim();if(/^[0-9]+$/.test(value)){childPid=Number(value);break;}}
   if(Date.now()>deadline)throw Error('Fixture did not start');await Bun.sleep(10);
  }
  if(mode==='abort')controller.abort();
  expect(String(await outcome)).toContain(mode==='timeout'?'timed out':'aborted');
  const reaped=Date.now()+2000;
  for(;;){
   let alive=true;
   try{process.kill(childPid,0);}catch(error){if(error instanceof Error&&'code' in error&&error.code==='ESRCH')alive=false;else throw error;}
   if(!alive)break;if(Date.now()>reaped)throw Error('Child survived cancellation');await Bun.sleep(10);
  }
 }finally{
  controller.abort();if(childPid)try{process.kill(childPid,'SIGKILL');}catch{}
  await rm(root,{recursive:true,force:true});
 }
});
