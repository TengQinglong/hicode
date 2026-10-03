import {createHash,randomUUID} from 'node:crypto';
import {mkdir,rm,writeFile,cp,realpath,readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {z} from 'zod';
import {EVAL_ROOT} from '../paths.js';
import {readJson,save,run,exists,tree} from './store.js';
import {lease} from './lease.js';
import {validateSweTask} from './sweTasks.js';
import {validatePublicTask} from './publicTasks.js';
import type {CatalogTask} from './catalog.js';

const hash=z.string().regex(/^[a-f0-9]{64}$/);
const imageId=z.string().regex(/^sha256:[a-f0-9]{64}$/);
const layerSchema=z.object({version:z.literal(1),kind:z.enum(['base','dependencies','task']),key:hash,
  imageId,parentImage:imageId,archiveSha256:hash,createdAt:z.string().datetime()}).strict();
const bindingSchema=z.object({version:z.literal(1),task:z.string(),sourceHash:hash,
  base:layerSchema,dependencies:layerSchema,preparation:layerSchema.nullable()}).strict().refine(value=>
    value.base.kind==='base'&&value.dependencies.kind==='dependencies'&&value.dependencies.parentImage===value.base.imageId&&
    (!value.preparation||(value.preparation.kind==='task'&&value.preparation.parentImage===value.dependencies.imageId)),
    'Invalid environment layer graph');
export type EnvironmentBinding=z.infer<typeof bindingSchema>;
type Layer=z.infer<typeof layerSchema>;
type TaskMetadata=Awaited<ReturnType<typeof validateSweTask>>|Awaited<ReturnType<typeof validatePublicTask>>;
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');

/** Images contain public environment inputs only. Run workspaces never enter this store. */
export class EnvironmentStore {
  private readonly dependencyBuilds=new Map<string,Promise<Layer>>();
  constructor(readonly root:string,private readonly context:string,private readonly machine:string){}
  private docker(...args:string[]){return ['docker','--context',this.context,...args];}
  private bindingPath(task:string){return join(this.root,'tasks',digest(task)+'.json');}
  private async inspect(name:string){
    const result=JSON.parse(await run(this.docker('image','inspect',name)));
    return z.array(z.object({Id:imageId,Architecture:z.string(),Config:z.object({Labels:z.record(z.string()).nullable().optional()})})).length(1).parse(result)[0]!;
  }
  private async verifyImage(layer:Layer){
    const image=await this.inspect(layer.imageId);
    if(image.Config.Labels?.['dev.hicode.environment']!==layer.key)throw Error('Environment image identity changed');
  }
  private async available(layer:Layer){
    const ids=await run(this.docker('image','ls','-a','--no-trunc','--quiet','--filter','label=dev.hicode.environment='+layer.key));
    return ids.split('\n').includes(layer.imageId);
  }
  private async export(kind:'base'|'swe'|'wheels',values:readonly string[],stage:string,name='environment.tar.gz'){
    const remote='/tmp/hicode-environment-'+randomUUID().replaceAll('-','')+'.tar.gz';
    try {
      const metadata=z.object({sha256:hash,archiveBytes:z.number().positive(),expandedBytes:z.number().nonnegative()}).parse(JSON.parse(
        await run(this.docker('exec',this.machine,'python3','/opt/hicode-eval/environment_export.py',kind,remote,...values),{timeout:300000})));
      await run(this.docker('cp',this.machine+':'+remote,join(stage,name)),{timeout:180000});
      const blob=Bun.file(join(stage,name));
      const actual=new Bun.CryptoHasher('sha256');
      const reader=blob.stream().getReader();
      for(;;){const {done,value}=await reader.read();if(done)break;actual.update(value);}
      if(actual.digest('hex')!==metadata.sha256)throw Error('Environment export changed during transfer');
      return metadata.sha256;
    } finally {await run(this.docker('exec',this.machine,'rm','-f','--',remote)).catch(()=>{});}
  }
  private async build(kind:Layer['kind'],parent:string,archiveSha256:string,stage:string,body:string){
    const key=digest(JSON.stringify({version:1,kind,parent,archiveSha256,body}));
    const directory=join(this.root,'layers',key),receipt=join(directory,'layer.json');
    if(await exists(receipt)){const layer=await readJson(receipt,layerSchema);if(await this.available(layer)){await this.verifyImage(layer);return layer;}}
    await mkdir(directory,{recursive:true,mode:0o700});
    const release=await lease(directory,'build');
    try {
      if(await exists(receipt)){const layer=await readJson(receipt,layerSchema);if(await this.available(layer)){await this.verifyImage(layer);return layer;}}
      const tag='hicode-env-'+kind+':'+key;
      // A separate environment store can already own this content-addressed image.
      // Rebuilding its tag could orphan that store's immutable image receipt.
      if(await run(this.docker('image','ls','--quiet','--filter','reference='+tag))){
        const image=await this.inspect(tag);
        const layer:Layer={version:1,kind,key,imageId:image.Id,parentImage:imageId.parse(parent),archiveSha256,createdAt:new Date().toISOString()};
        await this.verifyImage(layer);await save(receipt,layer);return layer;
      }
      // BuildKit resolves a local tag; record and verify its immutable parent ID.
      const parentTag='hicode-env-parent:'+parent.replace('sha256:','');
      await run(this.docker('tag',parent,parentTag));
      await writeFile(join(stage,'Dockerfile'),`FROM ${parentTag}\nUSER root\n${body}\nLABEL dev.hicode.environment="${key}" dev.hicode.layer="${kind}"\nWORKDIR /eval\nCMD ["sleep","infinity"]\n`);
      const output=await run(this.docker('build','--network=none','--pull=false','-t',tag,stage),{timeout:300000});
      await writeFile(join(directory,'build.log'),output);
      const image=await this.inspect(tag);
      const layer:Layer={version:1,kind,key,imageId:image.Id,parentImage:imageId.parse(parent),archiveSha256,createdAt:new Date().toISOString()};
      await this.verifyImage(layer);await save(receipt,layer);return layer;
    } finally {await release();}
  }
  async prepareBase(refresh=false):Promise<Layer>{
    await mkdir(this.root,{recursive:true,mode:0o700});
    const release=await lease(this.root,'prepare');
    const stage=join(this.root,'stage-'+randomUUID());await mkdir(stage);
    try {
      if(!refresh&&await exists(join(this.root,'base.json'))){const base=await readJson(join(this.root,'base.json'),layerSchema);await this.verifyImage(base);return base;}
      const info=z.array(z.object({State:z.object({Running:z.literal(true)}),Image:imageId,
        Config:z.object({Labels:z.record(z.string())})})).length(1).parse(JSON.parse(await run(this.docker('inspect',this.machine))))[0]!;
      if(info.Config.Labels['dev.hicode.role']!=='eval')throw Error('Environment preparation requires the dedicated cache machine');
      await run(this.docker('cp',join(EVAL_ROOT,'src/worker/environment_export.py'),this.machine+':/opt/hicode-eval/environment_export.py'));
      const archive=await this.export('base',[],stage);
      const layer=await this.build('base',info.Image,archive,stage,'ADD environment.tar.gz /');
      await save(join(this.root,'base.json'),layer);return layer;
    } finally {await rm(stage,{recursive:true,force:true});await release();}
  }
  private async identity(task:CatalogTask){
    if(!task.source)throw Error('Task source has not been prepared');
    const metadata=task.dataset==='swe-bench-verified'?await validateSweTask(task.id,task.source):await validatePublicTask(task.id,task.source);
    const recipe=digest((await Promise.all(['prepare_environment.py','venv_paths.py'].map(name=>readFile(join(EVAL_ROOT,'src/worker',name),'utf8')))).join('\n')+await readFile(join(EVAL_ROOT,'src/datasets/reviewed_test_deps.py'),'utf8'));
    if(task.preparation){
      if(await realpath(task.preparation.directory)!==resolve(task.preparation.directory))throw Error('Symlinked preparation directory');
      const files=await tree(task.preparation.directory);
      if(digest(JSON.stringify(files))!==task.preparation.sha256||!files[task.preparation.script])throw Error('Task preparation differs from its frozen recipe');
    }
    return {metadata,recipe,hash:digest(JSON.stringify({version:1,recipe,dataset:task.dataset,metadata,preparation:task.preparation??null}))};
  }
  private dependencies(metadata:TaskMetadata,recipe:string,base:Layer):Promise<Layer>{
    const inputs=typeof metadata.environment==='string'?metadata.environment:
      'packages' in metadata?{actor:metadata.packages,verifier:metadata.verifierPackages}:null;
    const key=digest(JSON.stringify({base:base.imageId,recipe,inputs}));
    let build=this.dependencyBuilds.get(key);
    if(!build){
      build=(async()=>{
        const stage=join(this.root,'stage-'+randomUUID());await mkdir(stage,{recursive:true,mode:0o700});
        try {
      const environment=typeof metadata.environment==='string'?metadata.environment:undefined;
      const swe=environment!==undefined;
      const values=environment?[environment]:[...('packages' in metadata?metadata.packages:[]),...('verifierPackages' in metadata?metadata.verifierPackages:[])];
      const archive=await this.export(swe?'swe':'wheels',values,stage);
      let body='ADD environment.tar.gz /';
      if(environment){
        const scripts=['prepare_environment.py','venv_paths.py'];
        await mkdir(join(stage,'worker'));
        for(const name of scripts)await cp(join(EVAL_ROOT,'src/worker',name),join(stage,'worker',name));
        const recipeHash=digest((await Promise.all(scripts.map(name=>readFile(join(stage,'worker',name),'utf8')))).join('\n'));
        body='COPY worker /opt/hicode-eval\n# recipe '+recipeHash+'\nRUN --mount=type=bind,source=environment.tar.gz,target=/tmp/hicode-dependencies.tar.gz '+
          JSON.stringify(['/bin/sh','-c','tar -xzf /tmp/hicode-dependencies.tar.gz -C / && python3 /opt/hicode-eval/prepare_environment.py '+environment]);
      }else if('packages' in metadata){
        for(const [name,packages] of [['actor',metadata.packages],['verifier',metadata.verifierPackages]] as const){
          if(!packages.length)continue;
          body+='\nRUN '+JSON.stringify(['/opt/python313/bin/python3.13','-m','pip','install','--no-index','--no-cache-dir','--no-compile',
            '--target','/opt/hicode-terminal/'+name,...packages.flatMap(pin=>['--find-links','/opt/hicode-eval/wheels/'+pin.replace('==','-')]),...packages]);
        }
      }
      return await this.build('dependencies',base.imageId,archive,stage,body);
        }finally{await rm(stage,{recursive:true,force:true});}
      })();
      this.dependencyBuilds.set(key,build);
    }
    return build;
  }
  async prepareTask(task:CatalogTask):Promise<EnvironmentBinding>{
    const base=await readJson(join(this.root,'base.json'),layerSchema);await this.verifyImage(base);
    const identity=await this.identity(task);
    if(await exists(this.bindingPath(task.id))){
      const previous=await readJson(this.bindingPath(task.id),bindingSchema);
      if(previous.task===task.id&&previous.sourceHash===identity.hash&&previous.base.imageId===base.imageId&&
        await this.available(previous.dependencies)&&(!previous.preparation||await this.available(previous.preparation))){
        await this.verifyImage(previous.dependencies);if(previous.preparation)await this.verifyImage(previous.preparation);return previous;
      }
    }
    const stage=join(this.root,'stage-'+randomUUID());await mkdir(stage,{recursive:true,mode:0o700});
    try {
      const dependencies=await this.dependencies(identity.metadata,identity.recipe,base);
      let preparation:Layer|null=null;
      let preparationBody='',preparationHash='';
      if('repo' in identity.metadata){
        const metadata=identity.metadata;
        const pins=z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]*==[0-9][A-Za-z0-9.+-]*$/)).parse(JSON.parse(await run(['python3','-c',
          'import sys,json;sys.path.insert(0,sys.argv[1]);from reviewed_test_deps import reviewed_test_dependencies;print(json.dumps(reviewed_test_dependencies(sys.argv[2],sys.argv[3],sys.argv[4])))',
          join(EVAL_ROOT,'src/datasets'),metadata.repo,metadata.version,join(task.source!,'repository')])));
        if(pins.length){
          await run(this.docker('cp',join(EVAL_ROOT,'src/worker/prepare_wheels.py'),this.machine+':/opt/hicode-eval/prepare_wheels.py'));
          await run(this.docker('exec',this.machine,'python3','/opt/hicode-eval/prepare_wheels.py',metadata.environment,...pins),{timeout:120000});
          preparationHash=await this.export('wheels',pins,stage,'extras.tar.gz');
          preparationBody='ADD extras.tar.gz /\n';
          for(const view of ['actor','verifier'])preparationBody+='RUN '+JSON.stringify(['/opt/hicode-swe/'+view+'/bin/python','-m','pip','install','--no-index','--no-deps',
            ...pins.flatMap(pin=>['--find-links','/opt/hicode-eval/wheels/'+pin.replace('==','-')]),...pins])+'\n';
          preparationBody+='RUN ["chown","-R","20000:20000","/opt/hicode-swe/actor","/opt/hicode-swe/verifier"]\n';
        }
      }
      if(task.preparation){
        const setup=task.preparation;
        if(await realpath(setup.directory)!==resolve(setup.directory))throw Error('Symlinked preparation directory');
        const files=await tree(setup.directory);
        if(digest(JSON.stringify(files))!==setup.sha256||!files[setup.script])throw Error('Task preparation differs from its frozen recipe');
        await cp(setup.directory,join(stage,'preparation'),{recursive:true,errorOnExist:true});
        preparationHash=digest(preparationHash+setup.sha256);
        preparationBody+='COPY preparation /opt/hicode-task/source\nRUN '+JSON.stringify(['/bin/bash','/opt/hicode-task/source/'+setup.script]);
      }
      if(preparationBody)preparation=await this.build('task',dependencies.imageId,preparationHash,stage,preparationBody);
      const binding:EnvironmentBinding={version:1,task:task.id,sourceHash:identity.hash,base,dependencies,preparation};
      await save(this.bindingPath(task.id),binding);return binding;
    } finally {await rm(stage,{recursive:true,force:true});}
  }
  async resolve(task:CatalogTask):Promise<EnvironmentBinding>{
    const binding=await readJson(this.bindingPath(task.id),bindingSchema);
    if(binding.task!==task.id||binding.sourceHash!==(await this.identity(task)).hash)throw Error('Task environment is stale; prepare it before submission');
    await this.verifyImage(binding.preparation??binding.dependencies);return binding;
  }
  async ready(task:CatalogTask):Promise<boolean>{return exists(this.bindingPath(task.id));}
}
