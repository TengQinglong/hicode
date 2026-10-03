import {createHash} from 'node:crypto';
import {z} from 'zod';
import type {Config} from './types.js';
import {idSchema} from './types.js';
import {run} from './store.js';

const inspectSchema=z.array(z.object({Id:z.string(),Image:z.string(),State:z.object({Running:z.boolean()}),
  Config:z.object({Labels:z.record(z.string())})})).length(1);

/** One disposable container and network per attempt; no shared writable mounts. */
export class RunContainers {
  readonly owner:string;
  constructor(private readonly config:Config){this.owner=createHash('sha256').update(config.data).digest('hex');}
  name(id:string){idSchema.parse(id);return 'hicode-run-'+this.owner.slice(0,12)+'-'+id;}
  private network(id:string){return this.name(id)+'-net';}
  private docker(...args:string[]){return ['docker','--context',this.config.context,...args];}
  async create(id:string,image:string):Promise<string>{
    if(!/^sha256:[a-f0-9]{64}$/.test(image))throw Error('An immutable prepared image is required');
    const name=this.name(id),network=this.network(id);
    await run(this.docker('network','create','--label','dev.hicode.owner='+this.owner,'--label','dev.hicode.run='+id,network));
    try {
      await run(this.docker('create','--name',name,'--init','--user','root','--network',network,
        '--memory',String(this.config.memoryMb)+'m','--cpus',String(this.config.cpus),'--pids-limit','1024',
        '--security-opt','seccomp=unconfined','--security-opt','apparmor=hicode-development','--security-opt','systempaths=unconfined',
        '--label','dev.hicode.role=attempt','--label','dev.hicode.owner='+this.owner,'--label','dev.hicode.run='+id,
        image,'sleep','infinity'));
      await run(this.docker('start',name));await this.assert(id);return name;
    } catch(error){
      // A failed create must not delete a pre-existing container with a colliding name.
      const matches=await this.find(id).catch(():string[]=>[]);
      if(matches.includes(name))await run(this.docker('rm','-f',name)).catch(()=>{});
      await run(this.docker('network','rm',network)).catch(()=>{});throw error;
    }
  }
  async assert(id:string):Promise<string>{
    const name=this.name(id),info=inspectSchema.parse(JSON.parse(await run(this.docker('inspect',name))))[0]!;
    if(info.Config.Labels['dev.hicode.owner']!==this.owner||info.Config.Labels['dev.hicode.run']!==id||info.Config.Labels['dev.hicode.role']!=='attempt')
      throw Error('Run container ownership mismatch');
    if(!info.State.Running)throw Error('Run container is stopped; inspect retained evidence');
    return name;
  }
  private async find(id:string){
    const value=await run(this.docker('ps','-a','--filter','label=dev.hicode.owner='+this.owner,'--filter','label=dev.hicode.run='+id,'--format','{{.Names}}'));
    return value.split('\n').filter(Boolean);
  }
  async exists(id:string):Promise<boolean>{return (await this.find(id)).includes(this.name(id));}
  async remove(id:string):Promise<void>{
    const name=this.name(id),matches=await this.find(id);
    if(matches.some(value=>value!==name))throw Error('Unexpected run container identity');
    if(matches.length)await run(this.docker('rm','-f',name));
    const networks=await run(this.docker('network','ls','--filter','label=dev.hicode.owner='+this.owner,'--filter','label=dev.hicode.run='+id,'--format','{{.Name}}'));
    for(const network of networks.split('\n').filter(Boolean)){
      if(network!==this.network(id))throw Error('Unexpected run network identity');
      await run(this.docker('network','rm',network));
    }
  }
}
