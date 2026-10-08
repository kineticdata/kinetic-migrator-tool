// Loads a kinetic-sync project directory: config, environments, credentials,
// overrides, connection secrets and handler secrets.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { envBoundAttributesError } from './env-bound.mjs';
import { dataConfigError } from './artifacts/data.mjs';

export function envKey(name) {
  return String(name).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

export function parseDotEnv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1 || /\s/.test(line.slice(0, eq).trim())) continue;
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
      value = value.slice(1, -1);
    }
    out[line.slice(0, eq).trim()] = value;
  }
  return out;
}

export function secretFieldKey(field) {
  return field.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
}

const camel = (snake) => snake.toLowerCase().replace(/_([a-z0-9])/g, (m, c) => c.toUpperCase());

export function connectionSecrets(env, connectionName) {
  const prefix = `KINETIC_${envKey(env.name)}_SECRET_${envKey(connectionName)}__`;
  const out = {};
  for (const [k, v] of Object.entries(env.vars ?? {})) {
    if (k.startsWith(prefix) && v !== '') out[camel(k.slice(prefix.length))] = v;
  }
  return out;
}

// Encrypted handler property values for a first install. Keys are the
// property's env key (envKey of its name), e.g. "SMTP Password" -> SMTP_PASSWORD.
export function handlerSecrets(env, definitionId) {
  const prefix = `KINETIC_${envKey(env.name)}_HANDLER_${envKey(definitionId)}__`;
  const out = {};
  for (const [k, v] of Object.entries(env.vars ?? {})) {
    if (k.startsWith(prefix) && v !== '') out[k.slice(prefix.length)] = v;
  }
  return out;
}

const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`Invalid JSON in ${file}: ${e.message}`);
  }
};

export const validateEnvName = (name) => {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) {
    throw new Error(`Invalid environment name "${name}": use letters, digits, - and _`);
  }
};

export function loadEnvironment(projectDir, name, processEnv = process.env) {
  validateEnvName(name);
  const file = join(projectDir, 'environments', `${name}.json`);
  if (!existsSync(file)) {
    throw new Error(`Unknown environment "${name}": create environments/${name}.json in the project with {"url": "https://your-space.kinops.io"}`);
  }
  const def = readJson(file);
  if (!def.url) throw new Error(`environments/${name}.json has no "url"`);
  for (const k of Object.keys(def)) {
    if (!['url', 'readOnly'].includes(k)) {
      throw new Error(`environments/${name}.json: unknown key "${k}" (allowed: url, readOnly)`);
    }
  }
  if ('readOnly' in def && typeof def.readOnly !== 'boolean') {
    throw new Error(`environments/${name}.json: "readOnly" must be true or false`);
  }
  const dotenv = join(projectDir, `.env.${name}`);
  const allVars = { ...(existsSync(dotenv) ? parseDotEnv(readFileSync(dotenv, 'utf8')) : {}), ...processEnv };
  const vars = Object.fromEntries(Object.entries(allVars).filter(([k]) => k.startsWith('KINETIC_')));
  const k = envKey(name);
  const username = allVars[`KINETIC_${k}_USERNAME`];
  const password = allVars[`KINETIC_${k}_PASSWORD`];
  if (!username || !password) {
    throw new Error(`No credentials for "${name}": set KINETIC_${k}_USERNAME and KINETIC_${k}_PASSWORD, or put them in .env.${name} in the project`);
  }
  return { name, url: def.url.replace(/\/+$/, ''), readOnly: def.readOnly === true, username, password, vars };
}

export function loadOverrides(projectDir, name) {
  validateEnvName(name);
  const file = join(projectDir, 'overrides', `${name}.json`);
  const raw = existsSync(file) ? readJson(file) : {};
  return { artifacts: raw.artifacts ?? {}, replace: raw.replace ?? [] };
}

export function listOverrideEnvs(projectDir) {
  const dir = join(projectDir, 'overrides');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
}

export function loadConfig(projectDir) {
  const file = join(projectDir, 'kinetic-sync.config.json');
  const user = existsSync(file) ? readJson(file) : {};
  const config = {
    data: user.data ?? [],
    exclude: { kapps: [], forms: [], ...user.exclude },
    envBoundAttributes: user.envBoundAttributes ?? {},
  };
  const dataError = dataConfigError(config.data);
  if (dataError) throw new Error(`kinetic-sync.config.json: ${dataError}`);
  const ebaError = envBoundAttributesError(config.envBoundAttributes);
  if (ebaError) throw new Error(`kinetic-sync.config.json: ${ebaError}`);
  return config;
}
