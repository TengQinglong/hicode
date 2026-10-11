import {z} from 'zod';

/** Shared protocol identities must not load dataset execution implementations. */
export const datasetSchema=z.enum(['terminal-bench-2.1','swe-bench-verified','deep-swe']);
export type Dataset=z.infer<typeof datasetSchema>;
export const taskRefSchema=z.object({dataset:datasetSchema,id:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,180}$/)}).strict();
export type TaskRef=z.infer<typeof taskRefSchema>;
export function taskKey(task:TaskRef):string{return task.dataset+':'+task.id;}
