import {test,expect,spyOn} from 'bun:test';
import {RunContainers,ContainerCreationPendingError} from '../src/host/containers.js';
import {configSchema} from '../src/host/types.js';
import * as transport from '../src/host/store.js';
import * as network from '../../src/tools/webFetch/network.js';

const config=()=>configSchema.parse({version:1,data:'/tmp/fake-runs',context:'offline',machine:'cache',concurrency:5,budget:{},model:{source:'qwen',model:'fake',apiKeyEnv:'UNUSED',baseUrl:'https://offline.invalid/v1'}});
test('each attempt has its own network, identity and bounded resources without shared volumes',async()=>{
 const runtime=new RunContainers(config()),id='a'.repeat(16),image='sha256:'+'b'.repeat(64),calls:string[][]=[];
 const fake=spyOn(transport,'run').mockImplementation(async argv=>{
   calls.push(argv);
   if(argv.includes('inspect'))return JSON.stringify([{Id:'container',Image:image,State:{Running:true},Config:{Labels:{'dev.hicode.role':'attempt','dev.hicode.owner':runtime.owner,'dev.hicode.run':id}}}]);
   if(argv.includes('{{.Names}}'))return runtime.name(id);
   if(argv.includes('{{.Name}}'))return runtime.name(id)+'-net';
   return '';
 });
 try {
   expect(await runtime.create(id,image)).toBe(runtime.name(id));
   const create=calls.find(c=>c.includes('create')&&c.includes('--memory'))!;
   expect(create).toContain('4096m');expect(create).toContain('--cpus');expect(create).toContain(runtime.name(id)+'-net');
   expect(create).not.toContain('--mount');expect(create).not.toContain('-v');expect(create).not.toContain('--privileged');
   await runtime.remove(id);
   expect(calls.some(c=>c.includes('rm')&&c.includes(runtime.name(id)))).toBe(true);
   expect(calls.some(c=>c.includes('network')&&c.includes('rm'))).toBe(true);
 }finally{fake.mockRestore();}
});

test('container ownership mismatch fails closed',async()=>{
 const runtime=new RunContainers(config());
 const fake=spyOn(transport,'run').mockResolvedValue(JSON.stringify([{Id:'other',Image:'sha256:'+'b'.repeat(64),State:{Running:true},Config:{Labels:{'dev.hicode.owner':'another service'}}}]));
 try{await expect(runtime.assert('a'.repeat(16))).rejects.toThrow('ownership');}finally{fake.mockRestore();}
});

test('model HTTPS domains are pinned only to host-resolved public IPv4 addresses',async()=>{
 const runtime=new RunContainers(config()),id='a'.repeat(16),image='sha256:'+'b'.repeat(64),calls:string[][]=[];
 const resolve=spyOn(network,'resolvePublicAddresses').mockResolvedValue([
  {address:'203.0.114.10',family:4},{address:'2001:4860:4860::8888',family:6},
 ]);
 const fake=spyOn(transport,'run').mockImplementation(async argv=>{
  calls.push(argv);
  if(argv.includes('inspect'))return JSON.stringify([{Id:'container',Image:image,State:{Running:true},Config:{Labels:{'dev.hicode.role':'attempt','dev.hicode.owner':runtime.owner,'dev.hicode.run':id}}}]);
  return '';
 });
 try{
  await runtime.create(id,image,'https://models.example.com/v1');
  const create=calls.find(call=>call.includes('create')&&call.includes('--memory'))!;
  expect(create).toContain('models.example.com:203.0.114.10');
  expect(create.some(value=>value.includes('2001:4860'))).toBe(false);
  expect(resolve).toHaveBeenCalledWith('models.example.com');
 }finally{resolve.mockRestore();fake.mockRestore();}
});

test('invalid attempt/image identifiers never reach Docker',async()=>{
 const runtime=new RunContainers(config()),fake=spyOn(transport,'run').mockRejectedValue(Error('must not execute'));
 try {
  expect(()=>runtime.name('../other')).toThrow();
  await expect(runtime.create('a'.repeat(16),'mutable:latest')).rejects.toThrow('immutable');
  expect(fake).not.toHaveBeenCalled();
 }finally{fake.mockRestore();}
});

test('cold container creation has a separate bounded budget',async()=>{
 const runtime=new RunContainers(config()),id='a'.repeat(16),image='sha256:'+'b'.repeat(64);
 const budgets:number[]=[];
 const fake=spyOn(transport,'run').mockImplementation(async(argv,options)=>{
  if(argv.includes('--memory'))budgets.push(options?.timeout??30000);
  if(argv.includes('inspect'))return JSON.stringify([{Id:'container',Image:image,State:{Running:true},Config:{Labels:{'dev.hicode.role':'attempt','dev.hicode.owner':runtime.owner,'dev.hicode.run':id}}}]);
  return '';
 });
 try{
  await runtime.create(id,image);
  expect(budgets).toHaveLength(1);expect(budgets[0]).toBeGreaterThan(30000);expect(budgets[0]).toBeLessThanOrEqual(300000);
 }finally{fake.mockRestore();}
});

test('a timed out Docker create retains resources until late daemon completion is observed',async()=>{
 const runtime=new RunContainers(config()),id='a'.repeat(16),image='sha256:'+'b'.repeat(64),calls:string[][]=[];
 let visible=false;
 const fake=spyOn(transport,'run').mockImplementation(async(argv)=>{
  calls.push(argv);
  if(argv.includes('--memory'))throw new transport.CommandTimeoutError('docker',120000);
  if(argv.includes('{{.Names}}'))return visible?runtime.name(id):'';
  if(argv.includes('{{.Name}}'))return runtime.name(id)+'-net';
  return '';
 });
 try{
  await expect(runtime.create(id,image)).rejects.toBeInstanceOf(ContainerCreationPendingError);
  expect(calls.some(call=>call.includes('rm')||call.includes('start'))).toBe(false);
  expect(await runtime.exists(id)).toBe(false);
  visible=true;
  expect(await runtime.exists(id)).toBe(true);
  await runtime.remove(id);
  expect(calls.some(call=>call.includes('rm')&&call.includes(runtime.name(id)))).toBe(true);
  expect(calls.some(call=>call.includes('network')&&call.includes('rm'))).toBe(true);
 }finally{fake.mockRestore();}
});

test('an ordinary Docker create rejection cleans the owned network immediately',async()=>{
 const runtime=new RunContainers(config()),id='a'.repeat(16),image='sha256:'+'b'.repeat(64),calls:string[][]=[];
 const fake=spyOn(transport,'run').mockImplementation(async(argv)=>{
  calls.push(argv);
  if(argv.includes('--memory'))throw Error('Docker rejected container configuration');
  return '';
 });
 try{
  await expect(runtime.create(id,image)).rejects.toThrow('rejected');
  expect(calls.some(call=>call.includes('network')&&call.includes('rm'))).toBe(true);
 }finally{fake.mockRestore();}
});
