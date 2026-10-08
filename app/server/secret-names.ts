// Store names of per-environment secrets the engine reads from env.vars:
// connection auth fields (KINETIC_<ENV>_SECRET_<CONNECTION>__<FIELD>) and
// encrypted handler properties (KINETIC_<ENV>_HANDLER_<DEFINITION>__<PROPERTY>).
import { envKey } from './engine.ts';
import { isSecretName, isSecretProperty, secretFieldKey } from './engine-sync.ts';

// Secret auth fields per Integrator auth type (the export strips their values).
const AUTH_SECRETS: Record<string, string[]> = {
  basic: ['password'],
  raw_bearer_token: ['token'],
  bearer: ['token'],
  api_key: ['apiKey'],
  client_credentials: ['clientSecret'],
  oauth2: ['clientSecret'],
};

export function connectionSecretFields(data: unknown): string[] {
  const auth = (data as { config?: { auth?: Record<string, unknown> } } | null)?.config?.auth;
  const fields = new Set<string>(AUTH_SECRETS[String(auth?.authType ?? '')] ?? []);
  for (const k of Object.keys(auth ?? {})) if (isSecretName(k)) fields.add(k);
  return [...fields].sort();
}

export const connectionSecretName = (connection: string, field: string) => `${envKey(connection)}__${secretFieldKey(field)}`;

export function handlerSecretProperties(data: unknown): string[] {
  const props = (data as { properties?: unknown[] } | null)?.properties ?? [];
  return props.filter((p) => isSecretProperty(p)).map((p) => String((p as { name?: unknown }).name ?? '')).filter(Boolean);
}

export const handlerSecretName = (definitionId: string, property: string) => `${envKey(definitionId)}__${envKey(property)}`;
