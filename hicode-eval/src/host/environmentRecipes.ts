import {z} from 'zod';

// Recipes are package declarations, never installer commands or direct URLs.
const pin=z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]*==[0-9][A-Za-z0-9.!+_-]*$/);
export const dependencyRecipeSchema=z.object({
  version:z.literal(1),python:z.union([z.literal('3.6.15'),z.string().regex(/^3\.(?:8|9|10|11)\.[0-9]+$/)]),
  requirements:z.array(pin).min(1).max(500),
  buildRequirements:z.array(pin).max(100),
  buildEnvironment:z.record(z.string().regex(/^[A-Z_][A-Z0-9_]*$/),z.string().max(1000)),
  buildGroups:z.array(z.object({packages:z.array(pin).min(1).max(100),requirements:z.array(pin).max(100)}).strict()).max(32),
  systemPackages:z.array(z.string().regex(/^[a-z0-9][a-z0-9+.-]*(?:=[A-Za-z0-9:.+~_-]+)?$/)).max(100),
  provenance:z.string().min(1).max(1000),
}).strict().superRefine((value,ctx)=>{
  if(value.python==='3.6.15'&&(value.buildRequirements.length||Object.keys(value.buildEnvironment).length||value.buildGroups.length))
    ctx.addIssue({code:'custom',message:'Source-runtime recipes do not accept custom build steps or variables'});
  const names=value.requirements.map(pin=>pin.split('==')[0]!.toLowerCase().replaceAll(/[-_.]+/g,'-'));
  if(new Set(names).size!==names.length)ctx.addIssue({code:'custom',message:'Duplicate dependency name'});
  const versions=new Map(value.requirements.map(pin=>{const [name,version]=pin.split('==');return [name!.toLowerCase().replaceAll(/[-_.]+/g,'-'),version];}));
  for(const pin of value.buildRequirements){const [name,version]=pin.split('==');const normalized=name!.toLowerCase().replaceAll(/[-_.]+/g,'-');
    if(versions.has(normalized)&&versions.get(normalized)!==version)ctx.addIssue({code:'custom',message:'Build and runtime pins disagree'});
  }
  if(value.buildGroups.some(group=>group.packages.some(pin=>!value.requirements.includes(pin))))ctx.addIssue({code:'custom',message:'Build groups must use frozen runtime package pins'});
});
export type DependencyRecipe=z.infer<typeof dependencyRecipeSchema>;
const image=z.string().regex(/^[a-z0-9./_-]+@sha256:[a-f0-9]{64}$/);
export const baseImagesSchema=z.object({system:image,bun:image,node:image,python:image,uv:image}).strict();
