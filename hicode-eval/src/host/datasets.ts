import type {Dataset} from './taskIdentity.js';
export {datasetSchema,taskRefSchema,taskKey} from './taskIdentity.js';
export type {Dataset,TaskRef} from './taskIdentity.js';
import {validateDeepTask,deepExecution} from './deepTasks.js';
import {validatePublicTask,publicTaskNetwork} from './publicTasks.js';
import {validateSweTask, sweTree} from './sweTasks.js';
import {tree} from './store.js';
import {terminalExecution} from './terminalExecution.js';
import {sweExecution} from './sweExecution.js';
import type {prepareDeepActor} from './deepContinuation.js';
import type {EvalLayout} from './layout.js';
import type {Run} from './types.js';
import type {DatasetExecution} from './executionPlan.js';

export type TaskMetadata=Awaited<ReturnType<typeof validateDeepTask>>|Awaited<ReturnType<typeof validateSweTask>>|Awaited<ReturnType<typeof validatePublicTask>>;
type TaskAdapter={
  canContinue:boolean;
  recoverActor:((state:Run)=>ReturnType<typeof prepareDeepActor>)|null;
  network:(source:string)=>Promise<'open'|'isolated'>;
  validate:(id:string,source:string)=>Promise<TaskMetadata>;
  snapshot:(source:string)=>ReturnType<typeof tree>;
  execution:(state:Run,source:string)=>Promise<DatasetExecution>;
};

/** Registration validates against a staged declaration before publishing it. */
export function taskInputs(dataset:Dataset,definition:string):Pick<TaskAdapter,'validate'|'snapshot'>{
  const inputs={
    'terminal-bench-2.1':{validate:(id:string,source:string)=>validatePublicTask(id,source,definition),snapshot:tree},
    'deep-swe':{validate:(id:string,source:string)=>validateDeepTask(id,source,definition),snapshot:tree},
    'swe-bench-verified':{validate:validateSweTask,snapshot:sweTree},
  };
  return inputs[dataset];
}

export function taskAdapters(layout:EvalLayout):Record<Dataset,TaskAdapter>{
  return {
    'terminal-bench-2.1':{
      canContinue:true,
      recoverActor:null,
      network:publicTaskNetwork,
      ...taskInputs('terminal-bench-2.1',layout.definition('terminal-bench-2.1')),
      execution:(state,source)=>terminalExecution(state,source,layout.definition('terminal-bench-2.1')),
    },
    'deep-swe':{canContinue:true,recoverActor:async state=>(await import('./deepContinuation.js')).prepareDeepActor(layout,state),network:async()=> 'isolated',...taskInputs('deep-swe',layout.definition('deep-swe')),execution:(state,source)=>deepExecution(state,source,layout.definition('deep-swe'))},
    'swe-bench-verified':{canContinue:false,recoverActor:null,network:async()=> 'open',...taskInputs('swe-bench-verified',layout.definition('swe-bench-verified')),execution:sweExecution},
  };
}
