import {test,expect} from 'bun:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EVAL_ROOT} from '../src/paths.js';

test.each([['catalog','TaskCatalog'],['environments','EnvironmentStore'],['manager','Lab']] as const)(
 'host %s can load first without a runtime schema/adapter initialization cycle',async(name,exported)=>{
  const cwd=await mkdtemp(join(tmpdir(),'eval-import-'));
  const source=`const module=await import(${JSON.stringify(join(EVAL_ROOT,'src/host',name+'.ts'))}); if(typeof module[${JSON.stringify(exported)}]!=="function")throw Error("Missing production entry point");`;
  try{
   const proc=Bun.spawn([process.execPath,'-e',source],{cwd,env:{PATH:process.env.PATH,HOME:join(cwd,'unused-user')},stdout:'pipe',stderr:'pipe'});
   const timer=setTimeout(()=>proc.kill('SIGKILL'),10000);
   try{
    const [code,error]=await Promise.all([proc.exited,new Response(proc.stderr).text()]);
    expect(error).toBe('');expect(code).toBe(0);
   }finally{clearTimeout(timer);}
  }finally{await rm(cwd,{recursive:true,force:true});}
 });
