#!/usr/bin/env node
// kinetic-migrate: export a Kinetic Platform space into a project directory and
// promote it into another environment. See docs/PROMOTING.md.
import { parseArgs } from 'node:util';
import { resolve, dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runInit, runExport, runPlan, runApply, runCompare } from './lib/sync/commands.mjs';
import { runUi } from './lib/sync/ui-command.mjs';
import { upgradeProjectLayout } from './lib/sync/layout.mjs';
import { PRUNABLE } from './lib/sync/artifacts/index.mjs';

const USAGE = `Usage:
  node kinetic-migrate.mjs init    [--project <dir>]
  node kinetic-migrate.mjs export  [--project <dir>] --env <name>
  node kinetic-migrate.mjs plan    [--project <dir>] [--from <name>] --to <name> [--overwrite-drift]
  node kinetic-migrate.mjs apply   [--project <dir>] [--from <name>] --to <name> [--yes] [--overwrite-drift] [--prune <type>]...
  node kinetic-migrate.mjs compare [--project <dir>] --from <name> --to <name> [--raw]
  node kinetic-migrate.mjs ui      [--workspace <dir>] [--port <n>] [--no-open] [--fake]

--project defaults to the current directory.
ui starts the local web app (needs npm run build); --workspace defaults to ~/KineticMigrate;
--fake serves synthetic dev and test spaces from memory (same as KINETIC_MIGRATE_FAKE=1).
export writes snapshots/<name>/; plan and apply read snapshots/<from>/.
Without --from they read a legacy export/ folder, only when there is no snapshots/ folder.
--prune types: ${PRUNABLE.join(', ')}`;

const OPTIONS = {
  project: { type: 'string' },
  env: { type: 'string' },
  from: { type: 'string' },
  to: { type: 'string' },
  yes: { type: 'boolean' },
  raw: { type: 'boolean' },
  'overwrite-drift': { type: 'boolean' },
  prune: { type: 'string', multiple: true },
  help: { type: 'boolean', short: 'h' },
};

async function main(argv) {
  if (argv[0] === 'ui' && !argv.includes('--help') && !argv.includes('-h')) {
    const here = dirname(fileURLToPath(import.meta.url));
    const serverFile = join(here, 'dist', 'server.mjs');
    return runUi({
      argv: argv.slice(1), built: existsSync(serverFile), webDir: join(here, 'dist', 'web'),
      loadServer: () => import(pathToFileURL(serverFile).href), log: (m) => console.log(m),
    });
  }
  const { values, positionals } = parseArgs({ args: argv, options: OPTIONS, strict: true, allowPositionals: true });
  const [command] = positionals;
  if (!command || command === 'help' || values.help) {
    console.log(USAGE);
    return command || values.help ? 0 : 1;
  }
  const projectDir = resolve(values.project ?? process.cwd());
  const log = (m) => console.log(m);
  // Projects from before the file-name layout change are upgraded once.
  if (['export', 'plan', 'apply', 'compare'].includes(command) && existsSync(projectDir)) {
    const up = upgradeProjectLayout(projectDir);
    if (up.changed) {
      log('Upgraded the project to the new file-name layout (commit these changes):');
      for (const n of up.notes) log(`  ${n}`);
    }
  }
  const need = (flag) => {
    if (!values[flag]) throw new Error(`${command} needs --${flag} <environment>\n\n${USAGE}`);
    return values[flag];
  };
  switch (command) {
    case 'init': return runInit({ projectDir, log });
    case 'export': return (await runExport({ projectDir, envName: need('env'), log })).code;
    case 'plan': return (await runPlan({ projectDir, envName: need('to'), from: values.from, overwriteDrift: values['overwrite-drift'], log })).code;
    case 'apply': return (await runApply({
      projectDir, envName: need('to'), from: values.from, yes: values.yes, prune: values.prune ?? [],
      overwriteDrift: values['overwrite-drift'], log,
    })).code;
    case 'compare': return (await runCompare({ projectDir, from: need('from'), to: need('to'), raw: values.raw, log })).code;
    default: throw new Error(`Unknown command "${command}"\n\n${USAGE}`);
  }
}

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; },
  (e) => { console.error(`kinetic-migrate: ${e.message}`); process.exitCode = 1; },
);
