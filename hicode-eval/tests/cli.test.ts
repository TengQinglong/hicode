import {expect,test} from 'bun:test';
import {join} from 'node:path';
import {EVAL_ROOT} from '../src/paths.js';

async function cli(...args:string[]){
  const proc=Bun.spawn([process.execPath,join(EVAL_ROOT,'src/cli.ts'),...args],{stdout:'pipe',stderr:'pipe'});
  const [code,out,error]=await Promise.all([proc.exited,new Response(proc.stdout).text(),new Response(proc.stderr).text()]);
  return {code,out,error};
}

test('CLI documents the clean container workflow and rejects retired installers',async()=>{
  const help=await cli('--help');
  expect(help.code).toBe(0);
  expect(help.out).toContain('--machine hicode-eval-clean');
  expect(help.out).toContain('register-tasks');
  expect(help.out).toContain('prepare-environments');
  for(const command of ['prepare-swe','prepare-terminal']){
    expect(help.out).not.toContain(command);
    const result=await cli(command);
    expect(result.code).toBe(1);
    expect(result.error).toContain('Unknown command');
  }
});
