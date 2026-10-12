import {test,expect,spyOn} from 'bun:test';
import * as network from '../../src/tools/webFetch/network.js';
import {modelIpv4} from '../src/host/modelDns.js';

const answer=(address='203.0.114.10')=>({Status:0,Question:{name:'models.example.com.',type:1},Answer:[
 {name:'models.example.com.',type:5,data:'edge.example.com.'},{name:'edge.example.com.',type:1,data:address},
]});

test('valid local public IPv4 is used without an HTTPS DNS request',async()=>{
 const local=spyOn(network,'resolvePublicAddresses').mockResolvedValue([{address:'203.0.114.10',family:4}]);
 const fetch=spyOn(globalThis,'fetch').mockRejectedValue(Error('must not query'));
 try{expect(await modelIpv4('models.example.com')).toEqual(['203.0.114.10']);expect(fetch).not.toHaveBeenCalled();}
 finally{local.mockRestore();fetch.mockRestore();}
});

test('fake or IPv6-only local DNS falls back to validated HTTPS A records and their CNAME chain',async()=>{
 const local=spyOn(network,'resolvePublicAddresses').mockResolvedValue([{address:'198.18.0.20',family:4}]);
 const fetch=spyOn(globalThis,'fetch').mockResolvedValue(Response.json(answer()));
 try{
  expect(await modelIpv4('models.example.com')).toEqual(['203.0.114.10']);
  const [input,options]=fetch.mock.calls[0]!;
  const url=new URL(String(input));expect(url.origin).toBe('https://dns.alidns.com');expect(url.searchParams.get('name')).toBe('models.example.com');
  expect(options?.redirect).toBe('error');expect(options?.signal).toBeDefined();
  local.mockResolvedValue([{address:'2001:4860:4860::8888',family:6}]);
  fetch.mockResolvedValue(Response.json(answer()));
  expect(await modelIpv4('models.example.com')).toEqual(['203.0.114.10']);
 }finally{local.mockRestore();fetch.mockRestore();}
});

test('private, unrelated, oversized and failed public DNS answers remain blocked',async()=>{
 const local=spyOn(network,'resolvePublicAddresses').mockRejectedValue(Error('unusable local DNS'));
 const fetch=spyOn(globalThis,'fetch');
 try{
  for(const address of ['127.0.0.1','198.18.0.20','192.168.1.1']){
   fetch.mockResolvedValue(Response.json(answer(address)));await expect(modelIpv4('models.example.com')).rejects.toThrow('validated public');
  }
  fetch.mockResolvedValue(Response.json({...answer(),Question:{name:'other.example.com',type:1}}));
  await expect(modelIpv4('models.example.com')).rejects.toThrow('question mismatch');
  fetch.mockResolvedValue(Response.json({...answer(),Answer:[{name:'other.example.com.',type:1,data:'203.0.114.10'}]}));
  await expect(modelIpv4('models.example.com')).rejects.toThrow('validated public');
  fetch.mockResolvedValue(new Response('x'.repeat(65537)));await expect(modelIpv4('models.example.com')).rejects.toThrow('budget');
  fetch.mockResolvedValue(new Response('',{status:502}));await expect(modelIpv4('models.example.com')).rejects.toThrow('HTTP 502');
 }finally{local.mockRestore();fetch.mockRestore();}
});
