// Store names of per-environment secrets the engine reads from env.vars:
// connection auth fields (KINETIC_<ENV>_SECRET_<CONNECTION>__<FIELD>) and
// encrypted handler properties (KINETIC_<ENV>_HANDLER_<DEFINITION>__<PROPERTY>).
import { envKey } from './engine.ts';
import { engineConnectionSecretFields, isSecretProperty, secretFieldKey } from './engine-sync.ts';

// The auth type's secret field (verified against the Integrator schema), any
// secret-named auth field still present, and credentials kept elsewhere in
// the config (a SQL connection's password).
export const connectionSecretFields = (data: unknown): string[] => engineConnectionSecretFields(data);

export const connectionSecretName = (connection: string, field: string) => `${envKey(connection)}__${secretFieldKey(field)}`;

export function handlerSecretProperties(data: unknown): string[] {
  const props = (data as { properties?: unknown[] } | null)?.properties ?? [];
  return props.filter((p) => isSecretProperty(p)).map((p) => String((p as { name?: unknown }).name ?? '')).filter(Boolean);
}

export const handlerSecretName = (definitionId: string, property: string) => `${envKey(definitionId)}__${envKey(property)}`;
