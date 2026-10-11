import {cp,mkdir,mkdtemp,readdir,realpath,rename,rm} from 'node:fs/promises';
import {dirname,isAbsolute,join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {z} from 'zod';
import {datasetSchema,taskInputs,taskKey,taskRefSchema} from './datasets.js';
import type {TaskCatalog,CatalogTask} from './catalog.js';
import type {EvalLayout} from './layout.js';
import {contained,exists,readJson,save,tree} from './store.js';

const inputPath=z.string().min(1).max(4096).refine(path=>isAbsolute(path)&&!path.includes('\0'));
export const taskRegistrationSchema=z.object({
  dataset:datasetSchema,source:inputPath,
  ids:z.array(taskRefSchema.shape.id).min(1).max(100).optional(),
  definition:inputPath.optional(),
  preparation:z.object({directory:inputPath,script:z.string().regex(/^[A-Za-z0-9_.-]+\.sh$/)}).strict().optional(),
}).strict();
export type TaskRegistration=z.infer<typeof taskRegistrationSchema>;

async function canonical(path:string){
  const absolute=resolve(path);
  if(await realpath(absolute)!==absolute)throw Error('Registration inputs must use canonical paths');
  return absolute;
}

/** Called only by the service owner, with its existing catalog and control queue. */
export async function registerTasks(layout:EvalLayout,catalog:TaskCatalog,input:TaskRegistration){
  const request=taskRegistrationSchema.parse(input),journal=join(layout.state,'import.json');
  if(await exists(journal))throw Error('Interrupted import; run gc --apply before registering');
  const source=await canonical(request.source);
  if(contained(layout.root,source)||contained(source,layout.root))throw Error('Import sources must be separate from the data root');
  const selected=request.ids?new Set(request.ids):undefined;
  if(selected&&selected.size!==request.ids!.length)throw Error('Duplicate registration tasks');
  const names=(await readdir(source,{withFileTypes:true})).filter(d=>d.isDirectory()&&!d.isSymbolicLink()&&(!selected||selected.has(d.name))).map(d=>taskRefSchema.shape.id.parse(d.name));
  if(!names.length||names.length>100||selected&&names.length!==selected.size)throw Error('Every selected task needs a validated source (maximum 100)');
  if(request.definition&&request.dataset==='swe-bench-verified')throw Error('SWE-bench Verified has no external task definition');
  const preparation=request.preparation?await canonical(request.preparation.directory):undefined;
  if(preparation&&(contained(layout.root,preparation)||contained(preparation,layout.root)))throw Error('Preparation input must be separate from the data root');
  const stage=await mkdtemp(join(layout.builds,'import-'));
  const entries:Pick<CatalogTask,'id'|'dataset'|'source'|'preparation'>[]=[];
  try{
    const definition=layout.definition(request.dataset);
    let merged:Record<string,unknown>|undefined;
    let reviewedDefinition=definition;
    if(request.definition){
      const additions=await readJson(await canonical(request.definition),z.record(taskRefSchema.shape.id,z.unknown()));
      if(!isDeepStrictEqual(Object.keys(additions).sort(),names.slice().sort()))throw Error('Definition must contain exactly the selected new tasks');
      const previous=await exists(definition)?await readJson(definition,z.record(z.unknown())):{};
      for(const id of names)if(Object.hasOwn(previous,id)&&!isDeepStrictEqual(previous[id],additions[id]))throw Error('Cannot change an existing task definition: '+id);
      merged={...previous,...additions};
      reviewedDefinition=join(stage,'definition.json');await save(reviewedDefinition,merged);
    }
    const adapter=taskInputs(request.dataset,reviewedDefinition);
    for(const id of names){
      const task={dataset:request.dataset,id},target=layout.source(task);
      if(catalog.list().some(t=>taskKey(t)===taskKey(task))||await exists(target))throw Error('Task/source already exists: '+taskKey(task));
      const original=join(source,id),before=await adapter.snapshot(original),staged=join(stage,id);
      await mkdir(staged);
      await cp(original,join(staged,'source'),{recursive:true,errorOnExist:true,force:false,verbatimSymlinks:true,preserveTimestamps:true});
      if(!isDeepStrictEqual(await adapter.snapshot(join(staged,'source')),before))throw Error('Source changed during import');
      await adapter.validate(id,join(staged,'source'));
      let prepared:CatalogTask['preparation'];
      if(preparation&&request.preparation){
        const files=await tree(preparation),script=request.preparation.script;
        if(!files[script])throw Error('Preparation script missing');
        await cp(preparation,join(staged,'preparation'),{recursive:true,errorOnExist:true,force:false,verbatimSymlinks:true});
        if(!isDeepStrictEqual(await tree(join(staged,'preparation')),files))throw Error('Preparation changed during import');
        const directory=join(layout.preparations,task.dataset,id);
        if(await exists(directory))throw Error('Preparation path exists');
        prepared={directory,script,sha256:createHash('sha256').update(JSON.stringify(files)).digest('hex')};
      }
      entries.push({...task,source:target,...(prepared?{preparation:prepared}:{})});
    }
    for(const entry of entries){
      await mkdir(dirname(entry.source!),{recursive:true});await canonical(dirname(entry.source!));
      if(entry.preparation){await mkdir(dirname(entry.preparation.directory),{recursive:true});await canonical(dirname(entry.preparation.directory));}
    }
    await save(journal,{version:1,tasks:entries.map(t=>({dataset:t.dataset,id:t.id}))});
    // Append-only declarations cannot change the contract of any active task.
    if(merged)await save(definition,merged);
    for(const entry of entries){
      await canonical(dirname(entry.source!));
      await rename(join(stage,entry.id,'source'),entry.source!);
      if(entry.preparation){await canonical(dirname(entry.preparation.directory));await rename(join(stage,entry.id,'preparation'),entry.preparation.directory);}
    }
    await catalog.register(entries);await rm(journal);
    return {registered:entries.length,tasks:entries.map(t=>taskKey(t))};
  }finally{await rm(stage,{recursive:true,force:true});}
}
