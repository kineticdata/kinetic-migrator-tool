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
//   category: { name, kapp?, category? }  kapp slug, category slug or name
// A where-part that is left out matches any item.

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
  const parts = typeof key === 'string' ? key.split('/') : [];
  if (scope === 'kapp') return { kapp: parts[0] === 'kapps' && parts[2] === 'kapp' ? parts[1] : data?.slug };
  if (scope === 'form') {
    const keyed = parts[0] === 'kapps' && parts[2] === 'forms' && parts[4] === 'form';
    return { kapp: keyed ? parts[1] : undefined, form: keyed ? parts[3] : data?.slug };
  }
  // Team names may contain characters a file name cannot, so prefer the data.
  if (scope === 'team') return { team: data?.name ?? (parts[0] === 'teams' ? parts.slice(1).join('/') : undefined) };
  return {};
}

// The identity of an item nested inside its parent's artifact (a category
// inside a kapp export).
export function nestedIdentity(scope, parent, item) {
  if (scope === 'category') return { kapp: parent.kapp, category: item?.slug, categoryName: item?.name };
  return { ...parent };
}

export function ruleApplies(level, rule, identity) {
  if (typeof rule === 'string') return true;
  if (!isPlainObject(rule)) return false;
  for (const part of WHERE[level] ?? []) {
    const want = rule[part];
    if (want === undefined || want === null || want === '') continue;
    if (level === 'category' && part === 'category') {
      if (want !== identity.category && want !== identity.categoryName) return false;
    } else if (want !== identity[part]) return false;
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

// A description of what is wrong with an envBoundAttributes value, or null.
export function envBoundAttributesError(value) {
  if (!isPlainObject(value)) return '"envBoundAttributes" must map each level to a list of rules.';
  for (const [level, rules] of Object.entries(value)) {
    if (!ENV_BOUND_LEVELS.includes(level)) {
      return `"envBoundAttributes": unknown level "${level}" (use ${ENV_BOUND_LEVELS.join(', ')}).`;
    }
    if (!Array.isArray(rules)) return `"envBoundAttributes.${level}" must be a list.`;
    for (const [i, rule] of rules.entries()) {
      const where = `"envBoundAttributes.${level}" entry ${i + 1}`;
      if (typeof rule === 'string') {
        if (!isName(rule)) return `${where} is an empty attribute name.`;
        continue;
      }
      if (!isPlainObject(rule)) return `${where} must be an attribute name or an object with a "name".`;
      if (!isName(rule.name)) return `${where} needs a "name".`;
      const allowed = ['name', ...WHERE[level]];
      const extra = Object.keys(rule).find((k) => !allowed.includes(k));
      if (extra) {
        return `${where}: "${extra}" is not allowed at the ${level} level (allowed: ${allowed.join(', ')}).`;
      }
      for (const part of WHERE[level]) {
        if (part in rule && !isName(rule[part])) return `${where}: "${part}" must be a non-empty string (leave it out to match any).`;
      }
    }
  }
  return null;
}
