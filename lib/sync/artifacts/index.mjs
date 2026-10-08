// lib/sync/artifacts/index.mjs
// Every artifact module, in list order. handlers list after workflows, WebAPIs
// and routines (to find the handlers they reference); task-refs must be last:
// it summarises what the other modules collected. APPLY_ORDER is the
// dependency order for creates/updates (reversed for prunes and removals):
// handlers, then the routines that run them, then the WebAPIs and workflows
// that call both. A module's optional order(items, { reverse }) orders items
// of its own type (routines that call routines).
import space from './space.mjs';
import teams from './teams.mjs';
import models from './models.mjs';
import fileResources from './file-resources.mjs';
import connectionModules from './connections.mjs';
import kapps from './kapps.mjs';
import forms from './forms.mjs';
import webapis from './webapis.mjs';
import workflows from './workflows.mjs';
import data from './data.mjs';
import routines from './routines.mjs';
import handlers from './handlers.mjs';
import taskRefs from './task-refs.mjs';

export const MODULES = [
  space, teams, models, fileResources, ...connectionModules,
  kapps, forms, webapis, workflows, data, routines, handlers, taskRefs,
];

export const APPLY_ORDER = [
  space, teams, models, fileResources, ...connectionModules,
  handlers, routines, kapps, forms, webapis, workflows, data,
];

export const moduleFor = (key) => MODULES.find((m) => m.owns(key));

// `data` prunes rows inside its own apply step rather than whole artifacts.
export const PRUNABLE = [...MODULES.filter((m) => m.prune).map((m) => m.type), 'data'];
