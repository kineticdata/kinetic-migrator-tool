# kinetic-migrate

Explore a Kinetic Platform environment, compare it with another, build
changesets and promote them safely — from a local web UI or the command line.

- Engine: `lib/sync/` (plain JavaScript, no runtime dependencies)
- CLI: `node kinetic-migrate.mjs --help`
- Guide: [`docs/PROMOTING.md`](docs/PROMOTING.md)

## Web UI

```
npm run build
node kinetic-migrate.mjs ui [--workspace <dir>] [--port <n>] [--no-open]
```

Starts a local server on 127.0.0.1 and opens the browser at a one-time launch
URL (the session key is in that URL only). The workspace defaults to
`~/KineticMigrate`. In a development checkout, use `npm run dev` and
`npm run dev:server` instead.

Requires Node.js 20.6 or newer. Run the tests with `npm test`.
