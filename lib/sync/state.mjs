// Hashes of each artifact as last seen after an apply, for drift detection.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stableStringify } from './normalize.mjs';

const stateFile = (projectDir, env) => join(projectDir, 'state', `${env}.json`);

export function loadState(projectDir, env) {
  const file = stateFile(projectDir, env);
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
}

export function saveState(projectDir, env, state) {
  mkdirSync(join(projectDir, 'state'), { recursive: true });
  writeFileSync(stateFile(projectDir, env), stableStringify(state));
}
