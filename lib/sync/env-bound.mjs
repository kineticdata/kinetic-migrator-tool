// Pure: which attributes are environment-specific for a given item.
//
// `envBoundAttributes` maps a level (space, kapp, form, team, category) to a
// list of rules. A rule is either an attribute name (it applies to every item
// at that level) or an object naming the attribute and, optionally, where it
// applies:
//   space:    { name }
//   kapp:     { name, kapp? }             kapp slug
//   form:     { name, kapp?, form? }      kapp slug, form slug
//   team:     { name, team? }             team name
//   category: { name, kapp?, category? }  kapp slug, category slug
// A where-part that is left out matches any item.
import { tryDecodeSegment } from './store.mjs';

export const ENV_BOUND_LEVELS = ['space', 'kapp', 'form', 'team', 'category'];

const WHERE = {
  space: [],
  kapp: ['kapp'],
  form: ['kapp', 'form'],
  team: ['team'],
  category: ['kapp', 'category'],
};

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isName = (v) => typeof v === 'string' && v.trim() !== '';

export const ruleName = (rule) => (typeof rule === 'string' ? rule : rule?.name);

// The where-parts an item at `scope` is matched on, from its artifact key
// (kapps/<kapp>/kapp, kapps/<kapp>/forms/<form>/form, teams/<name>) and, when
// the key does not say, its data.
export function itemIdentity(scope, key, data) {
  // Key segments are encoded file names: decode them back to slugs.
  const parts = typeof key === 'string' ? key.split('/') : [];
  const seg = (i) => (parts[i] === undefined ? undefined : tryDecodeSegment(parts[i]));
  if (scope === 'kapp') return { kapp: parts[0] === 'kapps' && parts[2] === 'kapp' ? seg(1) ?? data?.slug : data?.slug };
  if (scope === 'form') {
    const keyed = parts[0] === 'kapps' && parts[2] === 'forms' && parts[4] === 'form';
    return { kapp: keyed ? seg(1) : undefined, form: keyed ? seg(3) ?? data?.slug : data?.slug };
  }
  // Team names may contain characters a file name cannot, so prefer the data.
  if (scope === 'team') return { team: data?.name ?? (parts[0] === 'teams' && parts.length === 2 ? seg(1) : undefined) };
  return {};
}

// The identity of an item nested inside its parent's artifact (a category
// inside a kapp export).
export function nestedIdentity(scope, parent, item) {
  // By slug only: a name can differ between environments.
  if (scope === 'category') return { kapp: parent.kapp, category: item?.slug };
  return { ...parent };
}

export function ruleApplies(level, rule, identity) {
  if (typeof rule === 'string') return true;
  if (!isPlainObject(rule)) return false;
  for (const part of WHERE[level] ?? []) {
    const want = rule[part];
    if (want === undefined || want === null || want === '') continue;
    if (want !== identity[part]) return false;
  }
  return true;
}

// The names of the environment-specific attributes of one item.
export function envBoundNames(envBoundAttributes, level, identity) {
  const rules = envBoundAttributes?.[level];
  if (!Array.isArray(rules) || !rules.length) return new Set();
  return new Set(rules.filter((r) => ruleApplies(level, r, identity)).map(ruleName).filter(isName));
}

// The same, for a top-level artifact.
export function envBoundNamesFor(envBoundAttributes, scope, key, data) {
  if (!scope) return new Set();
  return envBoundNames(envBoundAttributes, scope, itemIdentity(scope, key, data));
}

// What is wrong with one rule at `level`, or null.
function ruleError(level, rule) {
  if (typeof rule === 'string') return isName(rule) ? null : 'is an empty attribute name.';
  if (!isPlainObject(rule)) return 'must be an attribute name or an object with a "name".';
  if (!isName(rule.name)) return 'needs a "name".';
  const allowed = ['name', ...WHERE[level]];
  const extra = Object.keys(rule).find((k) => !allowed.includes(k));
  if (extra) return `: "${extra}" is not allowed at the ${level} level (allowed: ${allowed.join(', ')}).`;
  for (const part of WHERE[level]) {
    if (part in rule && !isName(rule[part])) return `: "${part}" must be a non-empty string (leave it out to match any).`;
  }
  return null;
}

const describe = (level, i, problem) => `"envBoundAttributes.${level}" entry ${i + 1}${problem.startsWith(':') ? '' : ' '}${problem}`;
const unknownLevel = (level) => `"envBoundAttributes": unknown level "${level}" (use ${ENV_BOUND_LEVELS.join(', ')}).`;

// A description of what is wrong with an envBoundAttributes value, or null
// (strict: a config PUT is refused).
export function envBoundAttributesError(value) {
  if (!isPlainObject(value)) return '"envBoundAttributes" must map each level to a list of rules.';
  for (const [level, rules] of Object.entries(value)) {
    if (!ENV_BOUND_LEVELS.includes(level)) return unknownLevel(level);
    if (!Array.isArray(rules)) return `"envBoundAttributes.${level}" must be a list.`;
    for (const [i, rule] of rules.entries()) {
      const problem = ruleError(level, rule);
      if (problem) return describe(level, i, problem);
    }
  }
  return null;
}

// Lenient, for loading a project: what cannot be used is left out and
// reported, so a hand-edited config never stops the project from loading.
export function sanitizeEnvBoundAttributes(value) {
  const warnings = [];
  const out = {};
  if (value === undefined) return { value: out, warnings };
  if (!isPlainObject(value)) return { value: out, warnings: ['"envBoundAttributes" must map each level to a list of rules; it is ignored.'] };
  for (const [level, rules] of Object.entries(value)) {
    if (!ENV_BOUND_LEVELS.includes(level)) { warnings.push(`${unknownLevel(level).slice(0, -1)}; it is ignored.`); continue; }
    if (!Array.isArray(rules)) { warnings.push(`"envBoundAttributes.${level}" must be a list; it is ignored.`); continue; }
    out[level] = [];
    for (const [i, rule] of rules.entries()) {
      const problem = ruleError(level, rule);
      if (problem) warnings.push(`${describe(level, i, problem).slice(0, -1)}; it is ignored.`);
      else out[level].push(rule);
    }
  }
  return { value: out, warnings };
}

// ---- Space settings kept per environment ----------------------------------
//
// Besides the space fields that are always environment-bound (name, slug,
// platform component locations, bundle paths; see ENV_BOUND_FIELDS), the
// project chooses which other space settings each environment keeps:
// `envBoundSpaceFields` in kinetic-sync.config.json. Left out, the defaults
// below apply.
export const DEFAULT_ENV_BOUND_SPACE_FIELDS = [
  'displayType', 'displayValue', 'trustedFrameDomains', 'trustedResourceDomains', 'allowedIps', 'allowedIpsEnabled',
];
export const OPTIONAL_ENV_BOUND_SPACE_FIELDS = [
  'loginPage', 'resetPasswordPage', 'afterLogoutPath', 'defaultLocale', 'defaultTimezone', 'sessionInactiveLimitInSeconds',
];
export const ENV_BOUND_SPACE_FIELD_CHOICES = [...DEFAULT_ENV_BOUND_SPACE_FIELDS, ...OPTIONAL_ENV_BOUND_SPACE_FIELDS];

// Settings that only make sense together: always kept (or promoted) as a pair.
export const SPACE_FIELD_PAIRS = [['displayType', 'displayValue'], ['allowedIps', 'allowedIpsEnabled']];
export const pairOf = (field) => SPACE_FIELD_PAIRS.find((p) => p.includes(field)) ?? null;

// In the order of ENV_BOUND_SPACE_FIELD_CHOICES, without repeats.
export const canonicalSpaceFields = (list) => ENV_BOUND_SPACE_FIELD_CHOICES.filter((f) => list.includes(f));

const SPACE_FIELDS = '"envBoundSpaceFields"';
const halfPair = (list) => SPACE_FIELD_PAIRS.find((p) => p.some((f) => list.includes(f)) && !p.every((f) => list.includes(f))) ?? null;

// Strict, for a config PUT: a description of what is wrong, or null.
export function envBoundSpaceFieldsError(value) {
  if (!Array.isArray(value) || value.some((f) => typeof f !== 'string')) return `${SPACE_FIELDS} must be a list of space setting names.`;
  const unknown = value.find((f) => !ENV_BOUND_SPACE_FIELD_CHOICES.includes(f));
  if (unknown !== undefined) return `${SPACE_FIELDS}: "${unknown}" cannot be kept per environment (choose from ${ENV_BOUND_SPACE_FIELD_CHOICES.join(', ')}).`;
  const half = halfPair(value);
  if (half) return `${SPACE_FIELDS}: "${half[0]}" and "${half[1]}" go together; list both or neither.`;
  return null;
}

// Lenient, for loading a project: absent means the defaults; names the tool
// does not know are left out, and half a pair stands for the whole pair, both
// reported.
export function sanitizeEnvBoundSpaceFields(value) {
  if (value === undefined) return { value: [...DEFAULT_ENV_BOUND_SPACE_FIELDS], warnings: [] };
  if (!Array.isArray(value)) {
    return { value: [...DEFAULT_ENV_BOUND_SPACE_FIELDS], warnings: [`${SPACE_FIELDS} must be a list of space setting names; the defaults are used.`] };
  }
  const warnings = [];
  for (const f of value) {
    if (!ENV_BOUND_SPACE_FIELD_CHOICES.includes(f)) warnings.push(`${SPACE_FIELDS}: ${JSON.stringify(f)} cannot be kept per environment; it is ignored.`);
  }
  const list = value.filter((f) => ENV_BOUND_SPACE_FIELD_CHOICES.includes(f));
  for (const pair of SPACE_FIELD_PAIRS) {
    if (pair.some((f) => list.includes(f)) && !pair.every((f) => list.includes(f))) {
      warnings.push(`${SPACE_FIELDS}: "${pair[0]}" and "${pair[1]}" go together; both are kept.`);
      list.push(...pair);
    }
  }
  return { value: canonicalSpaceFields(list), warnings };
}
