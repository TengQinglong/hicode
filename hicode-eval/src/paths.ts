import { resolve } from 'node:path';

export const EVAL_ROOT = resolve(import.meta.dir, '..');
export const REPOSITORY_ROOT = resolve(EVAL_ROOT, '..');
