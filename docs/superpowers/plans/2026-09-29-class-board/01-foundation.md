# Foundation

This workstream builds the ground every other task stands on.

- **Task F1** (Wave 1) scaffolds the npm-workspaces monorepo. It creates the root configs, the `shared`, `worker`, `web` and `e2e` packages, installs every dependency once with exact pinned versions, and adds one smoke test per test environment so later tasks know the tooling works. Task F2 (already written in master plan §8) drops the four contract files in afterwards; F1 is arranged so that F2's test command and the typecheck both pass with those files present, and so that everything also passes without them.
- **Tasks F3, F4 and F5** (Wave 2) are the three pure modules in `shared/`: slot names and board geometry (`slots.ts`), link validation and rewrites (`urls.ts`), and the pixel-art codec plus message validation (`pixelArt.ts`, `protocol.ts`). They implement exactly the exports in master plan §3.1, with thorough tests.

Every command is written for Git Bash from the repo root, `C:/Users/jacob/OneDrive/Documents/GitHub/class-board`, on branch `build/v1`.

## Third-party APIs used

Everything below was installed and run on 2026-09-29 (Node 24.16.0, npm 11.13.0, Windows 11). Every version is pinned exactly in the package files that F1 creates.

| Package | Version | Docs | Confirmed facts and gotchas |
|---|---|---|---|
| typescript | 7.0.2 | https://www.typescriptlang.org/tsconfig/ | The `latest` tag is the native (Go) compiler; the `tsc` binary and `tsc --noEmit -p .` work unchanged with `moduleResolution: "Bundler"`. |
| @types/node | 24.19.0 | https://www.npmjs.com/package/@types/node | Pinned at the root so the hoisted copy is deterministic (vitest and vite pull in Node types transitively). |
| vitest | 4.1.11 | https://vitest.dev/config/ | Vitest 5.0.2 exists, but `@cloudflare/vitest-plugin` needs `^4.1.0`, so every workspace uses 4.1.11 (one hoisted copy). `npm test -w shared -- slots` passes `slots` to Vitest as a file-name filter. |
| @cloudflare/vitest-plugin | 1.3.3 | https://developers.cloudflare.com/workers/testing/vitest-integration/ and the migration guide https://developers.cloudflare.com/workers/testing/vitest-integration/migration-guides/migrate-to-vitest-plugin/ | **Replaces `@cloudflare/vitest-pool-workers`**, which stopped at 0.22.0. That version pins wrangler 4.124.0 whose workerd only accepts compatibility dates up to 2026-08-22, so a 2026-09-01 date fails to boot ("This Worker requires compatibility date ... newest date supported ... is 2026-08-22"). The plugin bundles wrangler 4.144.0 and keeps the same API: `cloudflareTest()` from the package root, types from `@cloudflare/vitest-plugin/types`, and `cloudflare:test` exports `env`, `SELF`, `runInDurableObject`, `runDurableObjectAlarm` and the rest. The types mark `env` and `SELF` from `cloudflare:test` as deprecated in favor of `env` and `exports` from `cloudflare:workers`; both still work, and the master plan's contracts use `cloudflare:test`. |
| wrangler | 4.144.0 | https://developers.cloudflare.com/workers/wrangler/configuration/ | `wrangler.jsonc` works as written in F1. `wrangler dev` starts offline and without login (see the findings below). |
| @cloudflare/workers-types | 5.20260929.1 | https://www.npmjs.com/package/@cloudflare/workers-types | Chosen over generating types with `wrangler types`: it is the peer dependency partyserver asks for (`^4.20260424.1` or `^5.20260703.1`), and version 5 has a single entry point, so `"types": ["@cloudflare/workers-types"]` is enough. Nothing generated has to be committed. |
| partyserver | 0.5.10 | https://www.npmjs.com/package/partyserver | `Server` is declared `Server<Env extends Cloudflare.Env = Cloudflare.Env, Props = ...>`. That is why `worker/test/env.d.ts` augments `Cloudflare.Env` with the Worker's `Env`. `class Board extends Server {}` boots under wrangler and Vitest. |
| @cloudflare/puppeteer | 1.4.0 | https://developers.cloudflare.com/browser-run/puppeteer/ | `puppeteer.launch(env.BROWSER, { keep_alive })` (used by X6). `nodejs_compat` and `nodejs_compat_v2` are on by default for compatibility dates from 2026-08-04; `wrangler.jsonc` still lists `nodejs_compat` so the requirement is visible. See https://developers.cloudflare.com/browser-run/reference/wrangler/. |
| valibot | 1.5.0 | https://valibot.dev/api/ | Confirmed by running the F5 tests: `object` drops unknown keys; `variant` accepts a nested `variant` as an option; `strictTuple` rejects extra items; `custom` and `check` exist. Passing a type-guard function such as `isValidTip` straight to `v.check` fails typechecking (the guard narrows the input to `unknown`), so F5 wraps it in an arrow function. |
| partysocket | 1.3.0 | https://www.npmjs.com/package/partysocket | Only installed here (used by U3). |
| vite | 8.3.1 | https://vite.dev/config/ | Needs Node 20.19 or newer, or 22.12 or newer. In Git Bash, `BASE_PATH=/class-board/ npm run build` is rewritten by MSYS path conversion to `C:/Program Files/Git/class-board/`; use `MSYS_NO_PATHCONV=1 BASE_PATH=/class-board/ npm run build -w web` (Linux CI is unaffected). |
| happy-dom | 20.14.5 | https://github.com/capricorn86/happy-dom | The first web test run spends about 8 s starting the environment; later runs are faster. |
| @playwright/test | 1.63.0 | https://playwright.dev/docs/browsers | `npx playwright install chromium` downloads Chrome Headless Shell 153 (about 115 MB) to `%LOCALAPPDATA%\ms-playwright`. |

## Findings every later task should know

- **The `browser` binding does not break local development or tests.**
  - `wrangler dev` prints `env.BROWSER  Browser Run  local`, needs no login and no remote mode, and answers `curl http://localhost:8787/` with 404. It prints a harmless `Unable to fetch the Request.cf object` warning when offline.
  - The local browser is a real Chrome. The first `env.BROWSER` use downloads Chrome 126 into `%LOCALAPPDATA%\xdg.cache\.wrangler\chrome`. That is a network call, so tests must never touch the binding. `worker/vitest.config.ts` renames it (`UNUSED_BROWSER`), which makes `env.BROWSER` **undefined in every Durable Object and integration test**. `Env.BROWSER` is already optional, so code that skips screenshots when it is missing works as is. Screenshot tests inject a fake `Shooter`.
  - `.quickAction()` is not supported locally. Nothing in this project uses it.
- **Test bindings are fixed.** `worker/vitest.config.ts` sets `TEACHER_CODE=test-code` and the four other values from master plan §2 through `miniflare.bindings`. They win over `wrangler.jsonc` vars and over `worker/.dev.vars` (the plugin logs "Using secrets defined in .dev.vars" but the explicit bindings still win; confirmed with `.dev.vars` containing `letmein`).
- **Two worker Vitest configs.** `vitest.unit.config.ts` passes no `wrangler` option and no `main`, so `src/index.ts` is never loaded. A test file under `test/unit/` still passed with a syntax error appended to `src/index.ts`. `HTMLRewriter`, `Headers`, `Response` and `crypto` are available there. Its compatibility date (`2026-09-01`) is repeated from `wrangler.jsonc`; keep the two in step.
- **Typing `env` in worker tests.** `ProvidedEnv` (older docs) no longer exists. The current mechanism is the global `Cloudflare.Env` interface, which `env` from both `cloudflare:test` and `cloudflare:workers` uses. `worker/test/env.d.ts` makes it extend the Worker's real `Env` from `src/env.ts`.
- **`web/` sees Node's global types.** Vite's and Vitest's type declarations pull `@types/node` into the web program, so a bare `setTimeout(...)` is typed `NodeJS.Timeout`, not `number`. Web code should use `window.setTimeout` or `ReturnType<typeof setTimeout>`. (`const t: number = setTimeout(...)` fails `tsc`; `window.setInterval` and `import.meta.env.VITE_SERVER_URL` typecheck.)
- **`npm audit`** reports 3 high findings, all in `extract-zip`, reached through `@cloudflare/puppeteer` → `@puppeteer/browsers`. That code only runs when puppeteer downloads Chrome for Node; it is not bundled into the Worker. Do not run `npm audit fix --force`: it downgrades `@cloudflare/puppeteer` to 0.0.11.
- **F1 without F2.** Nothing in F1 imports `worker/src/env.ts`, except the type import inside `worker/test/env.d.ts`. Until F2 lands that import is unresolved, and `tsc` stays silent because `skipLibCheck: true` (in `tsconfig.base.json`) skips errors inside `.d.ts` files. Once F2 lands, `env.TEACHER_CODE` and the other bindings are typed. Proven both ways: root `npm test` and `npm run typecheck` pass without F2's files, and `npm test -w shared -- constants` plus the typecheck pass with them.

---

### Task F1: Scaffold workspaces, install all deps, configs, smoke tests

**Wave:** 1 · **Tier:** T2 (sonnet, medium) · **Depends on:** none (the orchestrator has already created branch `build/v1`)

**Files:**
- Create: `package.json`, `package-lock.json` (written by `npm install`), `tsconfig.base.json`, `.gitignore`, `.gitattributes`, `.editorconfig`, `.nvmrc`
- Create: `shared/package.json`, `shared/tsconfig.json`, `shared/vitest.config.ts`
- Create: `worker/package.json`, `worker/tsconfig.json`, `worker/vitest.config.ts`, `worker/vitest.unit.config.ts`, `worker/wrangler.jsonc`, `worker/.dev.vars.example`, `worker/src/index.ts`
- Create: `web/package.json`, `web/tsconfig.json`, `web/vite.config.ts`, `web/vitest.config.ts`, `web/src/vite-env.d.ts`
- Create: `e2e/package.json`, `e2e/tsconfig.json`
- Test: `shared/test/smoke.test.ts`, `worker/test/env.d.ts`, `worker/test/smoke.test.ts`, `worker/test/unit/smoke.test.ts`, `web/test/smoke.test.ts`

This task installs packages, so it is the only one allowed to touch `package.json` and the lockfile. It runs alone, so it may run the whole suite and the whole typecheck (steps 13 and 14).

- [ ] **Step 1: Create the root workspace files**

Work from the repo root: `cd "C:/Users/jacob/OneDrive/Documents/GitHub/class-board"`. Create each file with exactly this content.

`package.json`:

```json
{
  "name": "class-board",
  "private": true,
  "workspaces": ["shared", "worker", "web", "e2e"],
  "scripts": {
    "test": "npm run test --workspaces --if-present",
    "typecheck": "npm run typecheck --workspaces --if-present",
    "dev:worker": "npm run dev -w worker",
    "dev:web": "npm run dev -w web",
    "build": "npm run build -w web",
    "e2e": "npm run e2e -w e2e"
  },
  "devDependencies": {
    "@types/node": "24.19.0",
    "typescript": "7.0.2"
  }
}
```

`tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "strict": true,
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "skipLibCheck": true,
    "noEmit": true,
    "isolatedModules": true,
    "resolveJsonModule": true,
    "forceConsistentCasingInFileNames": true
  }
}
```

`.gitignore`:

```text
node_modules
dist
.wrangler
.dev.vars
test-results
playwright-report
coverage
*.log
```

`.gitattributes`:

```text
* text=auto eol=lf
```

`.editorconfig`:

```ini
root = true

[*]
charset = utf-8
end_of_line = lf
indent_style = space
indent_size = 2
insert_final_newline = true
trim_trailing_whitespace = true

[*.md]
trim_trailing_whitespace = false
```

`.nvmrc`:

```text
24
```

- [ ] **Step 2: Create the `shared` package**

`shared/package.json`:

```json
{
  "name": "@class-board/shared",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    "./*": "./src/*.ts"
  },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit -p ."
  },
  "dependencies": {
    "valibot": "1.5.0"
  },
  "devDependencies": {
    "vitest": "4.1.11"
  }
}
```

`shared/tsconfig.json`:

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2022"],
    "types": []
  },
  "include": ["src", "test", "vitest.config.ts"]
}
```

`shared/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
```

`shared/test/smoke.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import * as v from 'valibot';

describe('shared workspace', () => {
  it('runs vitest and resolves valibot', () => {
    expect(v.parse(v.string(), 'ok')).toBe('ok');
  });
});
```

- [ ] **Step 3: Create the `worker` package**

`worker/package.json`:

```json
{
  "name": "@class-board/worker",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "wrangler dev --port 8787",
    "deploy": "wrangler deploy",
    "test": "npm run test:unit && npm run test:do",
    "test:do": "vitest run --config vitest.config.ts",
    "test:unit": "vitest run --config vitest.unit.config.ts",
    "typecheck": "tsc --noEmit -p ."
  },
  "dependencies": {
    "@class-board/shared": "*",
    "@cloudflare/puppeteer": "1.4.0",
    "partyserver": "0.5.10"
  },
  "devDependencies": {
    "@cloudflare/vitest-plugin": "1.3.3",
    "@cloudflare/workers-types": "5.20260929.1",
    "vitest": "4.1.11",
    "wrangler": "4.144.0"
  }
}
```

`worker/tsconfig.json`:

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2022"],
    "types": ["@cloudflare/workers-types", "@cloudflare/vitest-plugin/types"]
  },
  "include": ["src", "test", "vitest.config.ts", "vitest.unit.config.ts"]
}
```

`worker/wrangler.jsonc` (Durable Object `Board`, SQLite migration, Browser Rendering binding, and the non-secret variables from master plan §2; `TEACHER_CODE` comes from `.dev.vars` locally and from a secret in production):

```jsonc
{
  "$schema": "../node_modules/wrangler/config-schema.json",
  "name": "class-board",
  "main": "src/index.ts",
  "compatibility_date": "2026-09-01",
  "compatibility_flags": ["nodejs_compat"],
  "durable_objects": {
    "bindings": [{ "name": "Board", "class_name": "Board" }]
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["Board"] }],
  "browser": { "binding": "BROWSER" },
  "vars": {
    "ALLOWED_ORIGINS": "https://jacobl-h.github.io,http://localhost:5173",
    "BOARD_ORIGIN": "https://jacobl-h.github.io",
    "PUBLIC_URL": "http://localhost:8787",
    "DAILY_MESSAGE_BUDGET": "2000000"
  }
}
```

`worker/.dev.vars.example`:

```text
TEACHER_CODE=letmein
```

`worker/src/index.ts` (a placeholder that only has to boot; Task W2 replaces it, and it deliberately does not import `./env`, which Task F2 creates in this same wave):

```ts
import { Server } from 'partyserver';

// Placeholder so wrangler and Vitest can boot. Task W2 replaces this file.
export class Board extends Server {}

export default {
  async fetch(): Promise<Response> {
    return new Response('Not found', { status: 404 });
  },
} satisfies ExportedHandler;
```

`worker/vitest.config.ts` (Durable Object and integration tests; loads `src/index.ts` through the wrangler config):

```ts
import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        // Renamed so `env.BROWSER` is undefined in tests. A real binding would download and
        // launch Chrome on first use; screenshot tests inject a fake Shooter instead.
        browserRendering: { binding: 'UNUSED_BROWSER' },
        // Fixed test bindings. They override wrangler.jsonc vars and worker/.dev.vars, so
        // editing production values can't change what the tests see.
        bindings: {
          TEACHER_CODE: 'test-code',
          BOARD_ORIGIN: 'https://jacobl-h.github.io',
          PUBLIC_URL: 'http://localhost:8787',
          ALLOWED_ORIGINS: 'https://jacobl-h.github.io,http://localhost:5173',
          DAILY_MESSAGE_BUDGET: '2000000',
        },
      },
    }),
  ],
  test: {
    include: ['test/*.test.ts'],
    exclude: ['test/unit/**'],
  },
});
```

`worker/vitest.unit.config.ts` (pure-module tests in workerd, without loading `src/index.ts`):

```ts
import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// No wrangler config and no `main`: src/index.ts is never loaded, so pure-module
// tests can't be broken by half-written Durable Object code.
export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: '2026-09-01',
        compatibilityFlags: ['nodejs_compat'],
      },
    }),
  ],
  test: {
    include: ['test/unit/**/*.test.ts'],
  },
});
```

`worker/test/env.d.ts` (types `env` for tests; its import resolves once F2 has created `worker/src/env.ts`):

```ts
import type { Env as WorkerEnv } from '../src/env';

// Types `env` in tests (from cloudflare:test and cloudflare:workers) with the Worker's real bindings.
declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {}
  }
}
```

`worker/test/smoke.test.ts`:

```ts
import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('worker scaffold', () => {
  it('answers unknown paths with 404', async () => {
    const res = await SELF.fetch('http://localhost/');
    expect(res.status).toBe(404);
  });

  it('provides the fixed test bindings', () => {
    // Reflect.get keeps this test independent of how the bindings are typed.
    expect(Reflect.get(env, 'TEACHER_CODE')).toBe('test-code');
  });
});
```

`worker/test/unit/smoke.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

describe('workerd unit environment', () => {
  it('provides HTMLRewriter, Headers, Response and crypto', () => {
    expect(typeof HTMLRewriter).toBe('function');
    expect(new Headers({ a: 'b' }).get('a')).toBe('b');
    expect(new Response('x').status).toBe(200);
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    expect(bytes).toHaveLength(8);
  });
});
```

- [ ] **Step 4: Create the `web` package**

`web/package.json`:

```json
{
  "name": "@class-board/web",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview",
    "test": "vitest run",
    "typecheck": "tsc --noEmit -p ."
  },
  "dependencies": {
    "@class-board/shared": "*",
    "partysocket": "1.3.0"
  },
  "devDependencies": {
    "happy-dom": "20.14.5",
    "vite": "8.3.1",
    "vitest": "4.1.11"
  }
}
```

`web/tsconfig.json`:

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": ["vite/client"]
  },
  "include": ["src", "test", "vite.config.ts", "vitest.config.ts"]
}
```

`web/vite.config.ts`:

```ts
import { defineConfig } from 'vite';

export default defineConfig({
  base: process.env.BASE_PATH ?? '/',
  server: { port: 5173, strictPort: true },
});
```

`web/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'happy-dom',
    include: ['test/**/*.test.ts'],
    environmentOptions: {
      happyDOM: {
        // happy-dom 20 fetches an attached <iframe src> over the real network; tests must never do that.
        settings: { navigation: { disableChildFrameNavigation: true } },
      },
    },
  },
});
```

`web/src/vite-env.d.ts`:

```ts
/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SERVER_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
```

`web/test/smoke.test.ts` (there is no `web/index.html` yet, since Task U6 owns it, so there is no build smoke test):

```ts
import { describe, expect, it } from 'vitest';

describe('web workspace', () => {
  it('runs in a DOM environment', () => {
    const el = document.createElement('div');
    el.textContent = 'ok';
    document.body.append(el);
    expect(document.body.textContent).toContain('ok');
  });
});
```

- [ ] **Step 5: Create the `e2e` package**

`e2e/package.json`:

```json
{
  "name": "@class-board/e2e",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "e2e": "playwright test"
  },
  "devDependencies": {
    "@playwright/test": "1.63.0"
  }
}
```

`e2e/tsconfig.json` (Task E1 adds the Playwright config and specs; `e2e` has no `typecheck` script):

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2022", "DOM"],
    "types": ["node"]
  },
  "include": ["**/*.ts"]
}
```

- [ ] **Step 6: Run a smoke test before installing and confirm it fails**

Run: `npm test -w shared`

Expected: FAIL. Nothing is installed yet, so the script cannot start Vitest: `'vitest' is not recognized as an internal or external command, operable program or batch file.` (on macOS or Linux: `vitest: not found`), followed by `npm error Lifecycle script 'test' failed`.

- [ ] **Step 7: Install every dependency**

Run: `npm install`

Expected: about 178 packages added, `package-lock.json` created, and `3 high severity vulnerabilities` (the `extract-zip` finding described above; leave it, and never run `npm audit fix --force`). Then confirm no version range slipped in:

Run: `grep -nE '": "[\^~]' package.json shared/package.json worker/package.json web/package.json e2e/package.json; echo "matches: $?"`

Expected: no matching lines and `matches: 1` (grep's exit code 1 means nothing matched).

- [ ] **Step 8: Install the Playwright browser and create the local secrets file**

Run: `npx playwright install chromium`

Expected: a progress bar up to 100% of about 115 MiB, then `Chrome Headless Shell ... downloaded to ...ms-playwright...` (it finishes at once if the browser is already cached).

Run: `cp worker/.dev.vars.example worker/.dev.vars`

Expected: no output. `worker/.dev.vars` is gitignored, so it never reaches a commit; `wrangler dev` reads it for `TEACHER_CODE`.

- [ ] **Step 9: Run the shared and web smoke tests**

Run: `npm test -w shared`
Expected: PASS, `Tests  1 passed (1)`.

Run: `npm test -w web`
Expected: PASS, `Tests  1 passed (1)`.

- [ ] **Step 10: Run the worker unit smoke test**

Run: `npm run test:unit -w worker`
Expected: PASS, `Tests  1 passed (1)`. It runs in workerd, where `HTMLRewriter`, `Headers`, `Response` and `crypto.getRandomValues` all exist.

- [ ] **Step 11: Run the worker Durable Object and integration smoke test**

Run: `npm run test:do -w worker`
Expected: PASS, `Tests  2 passed (2)`. Vitest logs `Using secrets defined in .dev.vars`, and `TEACHER_CODE` is still `test-code` because the fixed test bindings win. Only `test/smoke.test.ts` runs here; `test/unit/**` is excluded.

- [ ] **Step 12: Check that `wrangler dev` boots offline with the browser binding**

Start `npm run dev:worker` in the background (for example the Bash tool with `run_in_background: true`). It never exits by itself. Wait for it, then request the root path:

Run: `until curl -s -o /dev/null --max-time 2 http://localhost:8787/; do sleep 2; done; curl -s -i --max-time 5 http://localhost:8787/ | head -1`

Expected: `HTTP/1.1 404 Not Found`. The dev server's binding table lists `env.BROWSER  Browser Run  local`, and no login or `--remote` was needed.

Stop the background task, then make sure no runtime was left behind (this task runs alone in Wave 1, so nothing else uses `workerd`):

Run: `tasklist | grep -i workerd || echo "no workerd running"`

Expected: `no workerd running`. If a `workerd.exe` line appears, run `taskkill //F //IM workerd.exe` and check again.

- [ ] **Step 13: Run the whole typecheck and the whole test suite**

Task F2's files do not exist yet, and nothing needs them.

Run: `npm run typecheck`
Expected: exit code 0; `tsc --noEmit -p .` prints nothing for `shared`, `worker` and `web` (`e2e` has no `typecheck` script and is skipped).

Run: `npm test`
Expected: exit code 0, with these results in order: shared `Tests  1 passed (1)`, worker unit `Tests  1 passed (1)`, worker Durable Object `Tests  2 passed (2)`, web `Tests  1 passed (1)`.

- [ ] **Step 14: Confirm that F2's contract files fit (do not commit them; F2 owns them)**

This step only proves the scaffold, so run it only if F2's four files and its test are already on disk (`shared/src/constants.ts`, `shared/src/types.ts`, `worker/src/env.ts`, `web/src/contracts.ts`, `shared/test/constants.test.ts`); otherwise skip it.

Run: `npm test -w shared -- constants`
Expected: PASS, `Tests  2 passed (2)`.

Run: `npm run typecheck`
Expected: exit code 0. With `env.ts` present, `env.TEACHER_CODE` in `worker/test/smoke.test.ts` is typed as `string`.

- [ ] **Step 15: Commit (orchestrator)**

```bash
git add package.json package-lock.json tsconfig.base.json .gitignore .gitattributes .editorconfig .nvmrc shared/package.json shared/tsconfig.json shared/vitest.config.ts shared/test/smoke.test.ts worker/package.json worker/tsconfig.json worker/vitest.config.ts worker/vitest.unit.config.ts worker/wrangler.jsonc worker/.dev.vars.example worker/test/env.d.ts worker/test/smoke.test.ts worker/test/unit/smoke.test.ts worker/src/index.ts web/package.json web/tsconfig.json web/vite.config.ts web/vitest.config.ts web/src/vite-env.d.ts web/test/smoke.test.ts e2e/package.json e2e/tsconfig.json
git commit -m "chore(scaffold): scaffold workspaces, install all deps, configs, smoke tests (F1)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task F3: Slot names and geometry

**Wave:** 1 (runs alone, after F2) · **Tier:** T0 (haiku) · **Depends on:** F1, F2

**Files:**
- Create: `shared/src/slots.ts`
- Test: `shared/test/slots.test.ts`

Implements exactly the `shared/src/slots.ts` exports in master plan §3.1. Two behaviors the contract leaves open: `slotRowCol`, `slotName`, `tileRect` and `labelRect` throw a `RangeError` for an index that is not a slot (a caller bug, not a runtime condition), and `slotAt` treats each cell as half-open, so the far edge of a tile already belongs to the gutter.

- [ ] **Step 1: Write the failing test**

`shared/test/slots.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { BOARD_H, BOARD_W, COL_PITCH, LABEL_H, ROW_PITCH, SLOT_COUNT, TILE_H, TILE_W } from '../src/constants';
import {
  isSlotIndex, labelRect, nearestSlot, parseSlotName, slotAt, slotName, slotRowCol, tileRect,
} from '../src/slots';

describe('isSlotIndex', () => {
  it('accepts integers from 0 to 79', () => {
    expect(isSlotIndex(0)).toBe(true);
    expect(isSlotIndex(23)).toBe(true);
    expect(isSlotIndex(79)).toBe(true);
  });

  it('rejects out-of-range, fractional, non-finite and non-number values', () => {
    for (const bad of [-1, 80, 1.5, NaN, Infinity, '3', null, undefined, {}, [1]]) {
      expect(isSlotIndex(bad)).toBe(false);
    }
  });
});

describe('slotRowCol and slotName', () => {
  it('maps slot indexes to zero-based rows and columns', () => {
    expect(slotRowCol(0)).toEqual({ row: 0, col: 0 });
    expect(slotRowCol(9)).toEqual({ row: 0, col: 9 });
    expect(slotRowCol(10)).toEqual({ row: 1, col: 0 });
    expect(slotRowCol(23)).toEqual({ row: 2, col: 3 });
    expect(slotRowCol(79)).toEqual({ row: 7, col: 9 });
  });

  it('names slots A1 through H10, with C4 at index 23', () => {
    expect(slotName(0)).toBe('A1');
    expect(slotName(9)).toBe('A10');
    expect(slotName(10)).toBe('B1');
    expect(slotName(23)).toBe('C4');
    expect(slotName(79)).toBe('H10');
  });

  it('gives every slot a distinct name', () => {
    const names = new Set(Array.from({ length: SLOT_COUNT }, (_, i) => slotName(i)));
    expect(names.size).toBe(SLOT_COUNT);
  });

  it('throws a RangeError for an index that is not a slot', () => {
    expect(() => slotName(80)).toThrow(RangeError);
    expect(() => slotName(-1)).toThrow(RangeError);
    expect(() => slotRowCol(1.5)).toThrow(RangeError);
  });
});

describe('parseSlotName', () => {
  it('parses names case-insensitively', () => {
    expect(parseSlotName('C4')).toBe(23);
    expect(parseSlotName('c4')).toBe(23);
    expect(parseSlotName('A1')).toBe(0);
    expect(parseSlotName('a10')).toBe(9);
    expect(parseSlotName('H10')).toBe(79);
  });

  it('round-trips with slotName for every slot', () => {
    for (let i = 0; i < SLOT_COUNT; i++) expect(parseSlotName(slotName(i))).toBe(i);
  });

  it('returns null for columns and rows outside the grid', () => {
    for (const bad of ['C11', 'C0', 'I1', 'A11', 'Z9', 'H100']) {
      expect(parseSlotName(bad)).toBeNull();
    }
  });

  it('returns null for malformed input', () => {
    for (const bad of ['', 'C', '4', 'C04', ' C4', 'C4 ', 'CC4', 'C-1', 'C4x', '#C4', '4C', 'C 4']) {
      expect(parseSlotName(bad)).toBeNull();
    }
  });

  it('returns null when the input is not a string', () => {
    expect(parseSlotName(undefined as unknown as string)).toBeNull();
    expect(parseSlotName(23 as unknown as string)).toBeNull();
  });
});

describe('tileRect and labelRect', () => {
  it('places corner tiles by pitch, below their label strip', () => {
    expect(tileRect(0)).toEqual({ x: 0, y: LABEL_H, w: TILE_W, h: TILE_H });
    expect(tileRect(9)).toEqual({ x: 9 * COL_PITCH, y: LABEL_H, w: TILE_W, h: TILE_H });
    expect(tileRect(70)).toEqual({ x: 0, y: 7 * ROW_PITCH + LABEL_H, w: TILE_W, h: TILE_H });
    expect(tileRect(79)).toEqual({ x: 9 * COL_PITCH, y: 7 * ROW_PITCH + LABEL_H, w: TILE_W, h: TILE_H });
  });

  it('puts the label strip directly above the tile body', () => {
    for (const slot of [0, 9, 23, 70, 79]) {
      const label = labelRect(slot);
      const body = tileRect(slot);
      expect(label).toEqual({ x: body.x, y: body.y - LABEL_H, w: TILE_W, h: LABEL_H });
    }
  });

  it('ends the last tile exactly at the board edge', () => {
    const last = tileRect(79);
    expect(last.x + last.w).toBe(BOARD_W);
    expect(last.y + last.h).toBe(BOARD_H);
  });

  it('throws a RangeError for an index that is not a slot', () => {
    expect(() => tileRect(80)).toThrow(RangeError);
    expect(() => labelRect(-1)).toThrow(RangeError);
  });
});

describe('slotAt', () => {
  it('finds the slot under a point on its label or body', () => {
    const body = tileRect(23);
    const label = labelRect(23);
    expect(slotAt(body.x + body.w / 2, body.y + body.h / 2)).toBe(23);
    expect(slotAt(label.x + 10, label.y + 10)).toBe(23);
  });

  it('includes the top-left corner and excludes the far edges', () => {
    expect(slotAt(0, 0)).toBe(0);
    expect(slotAt(TILE_W - 1, LABEL_H + TILE_H - 1)).toBe(0);
    expect(slotAt(TILE_W, 100)).toBeNull();
    expect(slotAt(100, LABEL_H + TILE_H)).toBeNull();
  });

  it('returns null in the gutters between tiles', () => {
    expect(slotAt(TILE_W + 10, 100)).toBeNull();
    expect(slotAt(100, LABEL_H + TILE_H + 10)).toBeNull();
    expect(slotAt(COL_PITCH - 1, ROW_PITCH - 1)).toBeNull();
  });

  it('starts the next tile at the pitch', () => {
    expect(slotAt(COL_PITCH, 10)).toBe(1);
    expect(slotAt(10, ROW_PITCH)).toBe(10);
  });

  it('returns null outside the board and for non-finite points', () => {
    expect(slotAt(-1, 10)).toBeNull();
    expect(slotAt(10, -1)).toBeNull();
    expect(slotAt(BOARD_W, 10)).toBeNull();
    expect(slotAt(10, BOARD_H)).toBeNull();
    expect(slotAt(NaN, 10)).toBeNull();
    expect(slotAt(10, Infinity)).toBeNull();
  });

  it('agrees with tileRect for every slot center', () => {
    for (let i = 0; i < SLOT_COUNT; i++) {
      const r = tileRect(i);
      expect(slotAt(r.x + r.w / 2, r.y + r.h / 2)).toBe(i);
    }
  });
});

describe('nearestSlot', () => {
  it('returns the slot itself for any point inside its body or label', () => {
    const body = tileRect(23);
    expect(nearestSlot(body.x + 5, body.y + 5)).toBe(23);
    expect(nearestSlot(labelRect(23).x + 5, labelRect(23).y + 5)).toBe(23);
  });

  it('picks the closer tile from a horizontal gutter', () => {
    expect(nearestSlot(TILE_W + 10, 100)).toBe(0);
    expect(nearestSlot(COL_PITCH - 10, 100)).toBe(1);
  });

  it('picks the closer tile from a vertical gutter, counting the label as part of the next row', () => {
    expect(nearestSlot(100, LABEL_H + TILE_H + 8)).toBe(0);
    expect(nearestSlot(100, ROW_PITCH)).toBe(10);
  });

  it('breaks an exact tie toward the lower slot', () => {
    expect(nearestSlot(TILE_W + 24, 100)).toBe(0);
  });

  it('snaps points outside the board to the nearest edge or corner tile', () => {
    expect(nearestSlot(-500, -500)).toBe(0);
    expect(nearestSlot(BOARD_W + 500, -500)).toBe(9);
    expect(nearestSlot(-500, BOARD_H + 500)).toBe(70);
    expect(nearestSlot(BOARD_W + 500, BOARD_H + 500)).toBe(79);
    expect(nearestSlot(3 * COL_PITCH + 100, -400)).toBe(3);
    expect(nearestSlot(3 * COL_PITCH + 100, BOARD_H + 400)).toBe(73);
  });

  it('returns a valid slot for every point on a coarse sweep', () => {
    for (let x = -600; x <= BOARD_W + 600; x += 397) {
      for (let y = -600; y <= BOARD_H + 600; y += 331) {
        expect(isSlotIndex(nearestSlot(x, y))).toBe(true);
      }
    }
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npm test -w shared -- slots`
Expected: FAIL, `Cannot find module '../src/slots' imported from .../shared/test/slots.test.ts`.

- [ ] **Step 3: Implement `shared/src/slots.ts`**

```ts
import {
  COL_PITCH, COLS, LABEL_H, ROW_PITCH, ROWS, SLOT_COUNT, TILE_H, TILE_W,
} from './constants';
import type { Rect, SlotIndex } from './types';

const ROW_LETTERS = Array.from({ length: ROWS }, (_, i) => String.fromCharCode(65 + i));
const NAME_RE = new RegExp(`^([A-${ROW_LETTERS[ROWS - 1]}])(${COLS}|[1-9])$`, 'i');
const CELL_H = LABEL_H + TILE_H;

export function isSlotIndex(n: unknown): n is SlotIndex {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 && n < SLOT_COUNT;
}

function assertSlot(slot: number): void {
  if (!isSlotIndex(slot)) throw new RangeError(`Not a slot index: ${slot}`);
}

export function slotRowCol(slot: SlotIndex): { row: number; col: number } {
  assertSlot(slot);
  return { row: Math.floor(slot / COLS), col: slot % COLS };
}

export function slotName(slot: SlotIndex): string {
  const { row, col } = slotRowCol(slot);
  return `${ROW_LETTERS[row]}${col + 1}`;
}

export function parseSlotName(name: string): SlotIndex | null {
  if (typeof name !== 'string') return null;
  const m = NAME_RE.exec(name);
  if (!m) return null;
  const row = m[1].toUpperCase().charCodeAt(0) - 65;
  return row * COLS + (Number(m[2]) - 1);
}

export function tileRect(slot: SlotIndex): Rect {
  const { row, col } = slotRowCol(slot);
  return { x: col * COL_PITCH, y: row * ROW_PITCH + LABEL_H, w: TILE_W, h: TILE_H };
}

export function labelRect(slot: SlotIndex): Rect {
  const { row, col } = slotRowCol(slot);
  return { x: col * COL_PITCH, y: row * ROW_PITCH, w: TILE_W, h: LABEL_H };
}

/** Index of the cell whose [start, start + size) span contains v, or -1 (gutter or outside). */
function cellIndex(v: number, pitch: number, size: number, count: number): number {
  if (!Number.isFinite(v) || v < 0) return -1;
  const i = Math.floor(v / pitch);
  return i < count && v - i * pitch < size ? i : -1;
}

export function slotAt(bx: number, by: number): SlotIndex | null {
  const col = cellIndex(bx, COL_PITCH, TILE_W, COLS);
  const row = cellIndex(by, ROW_PITCH, CELL_H, ROWS);
  return col < 0 || row < 0 ? null : row * COLS + col;
}

/** Index of the span [start, start + size] nearest to v; ties go to the lower index. */
function nearestIndex(v: number, start: (i: number) => number, size: number, count: number): number {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < count; i++) {
    const lo = start(i);
    const d = v < lo ? lo - v : v > lo + size ? v - (lo + size) : 0;
    if (d < bestDist) {
      best = i;
      bestDist = d;
    }
  }
  return best;
}

export function nearestSlot(bx: number, by: number): SlotIndex {
  // Tile bodies form a grid, so the nearest body is the nearest column crossed with the nearest row.
  const col = nearestIndex(bx, (i) => i * COL_PITCH, TILE_W, COLS);
  const row = nearestIndex(by, (i) => i * ROW_PITCH + LABEL_H, TILE_H, ROWS);
  return row * COLS + col;
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npm test -w shared -- slots`
Expected: PASS, `Tests  27 passed (27)`.

- [ ] **Step 5: Commit (orchestrator)**

```bash
git add shared/src/slots.ts shared/test/slots.test.ts
git commit -m "feat(shared): slot names and geometry (F3)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task F4: Link planning and rewrites

**Wave:** 2 · **Tier:** T1 (sonnet, low) · **Depends on:** F1, F2

**Files:**
- Create: `shared/src/urls.ts`
- Test: `shared/test/urls.test.ts`

Implements exactly the `shared/src/urls.ts` exports in master plan §3.1 (spec §5.7). Decisions the contract leaves open, all covered by tests:

- The length check runs on the trimmed input, before parsing, so a 3,000-character string of garbage reports `too_long`.
- `new URL()` normalizes numeric hosts (`2130706433`, `0x7f.1`, `127.1`) to dotted IPv4 before the host check, so those forms are rejected as IP literals. `*.localhost` is rejected along with `localhost`, and a trailing dot on a host is ignored for the check.
- A YouTube link is rewritten only when it carries an 11-character video id; otherwise it stays `generic`. Both `youtube.com` and `youtu.be` variants keep the original URL in `url` for Open in new tab.
- `claude.ai/public/artifacts/<id>` and the same URL ending in `/embed` both give `https://claude.ai/public/artifacts/<id>/embed`. Other paths on `claude.ai` stay `generic`.
- `originOf` returns an origin only for `http:` and `https:` URLs.

- [ ] **Step 1: Write the failing test for validation, generic links, `originOf` and `NOTES`**

`shared/test/urls.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { LIMITS } from '../src/constants';
import { NOTES, originOf, planLink } from '../src/urls';

describe('planLink: accepted links', () => {
  it('plans a plain https link as generic, embedding the normalized URL', () => {
    expect(planLink('https://example.com/page?x=1#top')).toEqual({
      ok: true,
      kind: 'generic',
      url: 'https://example.com/page?x=1#top',
      embedUrl: 'https://example.com/page?x=1#top',
      thumbUrl: null,
    });
  });

  it('accepts http links and normalizes the host case and empty path', () => {
    expect(planLink('HTTP://Example.COM')).toMatchObject({ ok: true, kind: 'generic', url: 'http://example.com/' });
  });

  it('trims surrounding whitespace, including newlines', () => {
    expect(planLink('  \n https://example.com/a \t')).toMatchObject({ ok: true, url: 'https://example.com/a' });
  });

  it('keeps ports and lets a trailing-dot public host through', () => {
    expect(planLink('https://example.com:8443/x')).toMatchObject({ ok: true, url: 'https://example.com:8443/x' });
    expect(planLink('https://example.com./x')).toMatchObject({ ok: true, kind: 'generic' });
  });

  it('converts internationalized hosts to punycode', () => {
    expect(planLink('https://中文.com/')).toMatchObject({ ok: true, url: 'https://xn--fiq228c.com/' });
  });

  it('accepts a link of exactly the maximum length', () => {
    const url = 'https://example.com/' + 'a'.repeat(LIMITS.urlMax - 'https://example.com/'.length);
    expect(url).toHaveLength(LIMITS.urlMax);
    expect(planLink(url)).toMatchObject({ ok: true, kind: 'generic' });
  });
});

describe('planLink: rejected links', () => {
  it('rejects schemes other than http and https', () => {
    for (const bad of [
      'javascript:alert(1)',
      'data:text/html,<h1>hi</h1>',
      'ftp://example.com/file',
      'file:///etc/passwd',
      'mailto:a@example.com',
      'blob:https://example.com/1234',
    ]) {
      expect(planLink(bad)).toEqual({ ok: false, reason: 'scheme' });
    }
  });

  it('rejects IPv4 literals, including forms the URL parser normalizes', () => {
    for (const bad of [
      'http://127.0.0.1/',
      'http://192.168.1.10:3000/',
      'https://8.8.8.8/',
      'http://2130706433/',
      'http://0x7f.1/',
      'http://127.1/',
    ]) {
      expect(planLink(bad)).toEqual({ ok: false, reason: 'host' });
    }
  });

  it('rejects IPv6 literals', () => {
    for (const bad of ['http://[::1]/', 'http://[::1]:8080/x', 'https://[2001:db8::1]/', 'http://[::ffff:1.2.3.4]/']) {
      expect(planLink(bad)).toEqual({ ok: false, reason: 'host' });
    }
  });

  it('rejects localhost, .localhost, .local and .internal hosts, with or without a trailing dot', () => {
    for (const bad of [
      'http://localhost:5173/',
      'http://LOCALHOST/',
      'http://localhost./',
      'http://app.localhost/',
      'http://printer.local/',
      'https://db.internal/',
      'https://a.b.internal./',
    ]) {
      expect(planLink(bad)).toEqual({ ok: false, reason: 'host' });
    }
  });

  it('does not reject public hosts that merely contain those words', () => {
    for (const ok of ['https://localhost.example.com/', 'https://notlocal.com/', 'https://internal.example.org/']) {
      expect(planLink(ok)).toMatchObject({ ok: true });
    }
  });

  it('rejects links longer than the limit before parsing them', () => {
    const long = 'https://example.com/' + 'a'.repeat(LIMITS.urlMax);
    expect(planLink(long)).toEqual({ ok: false, reason: 'too_long' });
    expect(planLink('x'.repeat(LIMITS.urlMax + 1))).toEqual({ ok: false, reason: 'too_long' });
  });

  it('rejects garbage as invalid', () => {
    for (const bad of ['', '   ', 'not a url', 'example.com', 'https://', 'http://exa mple.com', '//example.com', 'http://1.2.3.256']) {
      expect(planLink(bad)).toEqual({ ok: false, reason: 'invalid' });
    }
    expect(planLink(undefined as unknown as string)).toEqual({ ok: false, reason: 'invalid' });
    expect(planLink(42 as unknown as string)).toEqual({ ok: false, reason: 'invalid' });
  });
});

describe('originOf', () => {
  it('returns the origin of http and https URLs', () => {
    expect(originOf('https://jacobl-h.github.io/class-board/?board=x#C4')).toBe('https://jacobl-h.github.io');
    expect(originOf('http://localhost:5173/a')).toBe('http://localhost:5173');
    expect(originOf('https://example.com:443/')).toBe('https://example.com');
  });

  it('returns null for other schemes and for input that is not a URL', () => {
    expect(originOf('data:text/html,hi')).toBeNull();
    expect(originOf('blob:https://example.com/1')).toBeNull();
    expect(originOf('ftp://example.com')).toBeNull();
    expect(originOf('nope')).toBeNull();
    expect(originOf('')).toBeNull();
  });
});

describe('NOTES', () => {
  it('has the exact user-facing texts from the spec', () => {
    expect(NOTES.claudeNew).toBe(
      "Newer Claude artifacts can't be embedded and need a Claude account to open. Upload the artifact's HTML file instead.",
    );
    expect(NOTES.blocked).toBe("This site doesn't allow embedding. Open it in a new tab.");
    expect(NOTES.claudeAllow('jacobl-h.github.io')).toBe(
      "Add jacobl-h.github.io to this artifact's Allowed domains in Claude (Publish → Get embed code) to show it live.",
    );
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npm test -w shared -- urls`
Expected: FAIL, `Cannot find module '../src/urls' imported from .../shared/test/urls.test.ts`.

- [ ] **Step 3: Implement validation, generic planning, `originOf` and `NOTES`**

`shared/src/urls.ts`:

```ts
import { LIMITS } from './constants';

export type LinkPlan =
  | { ok: true; kind: 'generic' | 'youtube' | 'claude-published'; url: string; embedUrl: string; thumbUrl: string | null }
  | { ok: true; kind: 'claude-new'; url: string; embedUrl: null; thumbUrl: null }
  | { ok: false; reason: 'invalid' | 'scheme' | 'host' | 'too_long' };

export const NOTES = {
  claudeNew: "Newer Claude artifacts can't be embedded and need a Claude account to open. Upload the artifact's HTML file instead.",
  claudeAllow: (boardHost: string): string =>
    `Add ${boardHost} to this artifact's Allowed domains in Claude (Publish → Get embed code) to show it live.`,
  blocked: "This site doesn't allow embedding. Open it in a new tab.",
};

const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

/** True for hosts a class board must never load: IP literals and local or internal names. */
function isBlockedHost(hostname: string): boolean {
  // new URL() has already normalized numeric hosts such as 2130706433 or 0x7f.1 to dotted IPv4.
  if (hostname.startsWith('[') || IPV4_RE.test(hostname)) return true;
  const host = hostname.replace(/\.$/, '');
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  );
}

export function planLink(input: string): LinkPlan {
  if (typeof input !== 'string') return { ok: false, reason: 'invalid' };
  const trimmed = input.trim();
  if (trimmed.length > LIMITS.urlMax) return { ok: false, reason: 'too_long' };
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, reason: 'scheme' };
  if (isBlockedHost(u.hostname)) return { ok: false, reason: 'host' };
  return { ok: true, kind: 'generic', url: u.href, embedUrl: u.href, thumbUrl: null };
}

/** The origin of an http(s) URL, or null for anything else (including unparsable input). */
export function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npm test -w shared -- urls`
Expected: PASS, `Tests  16 passed (16)`.

- [ ] **Step 5: Add the failing tests for YouTube and Claude rewrites**

Append this to the end of `shared/test/urls.test.ts`, leaving one blank line after the last `});`:

```ts
const YT = 'dQw4w9WgXcQ';
const YT_EMBED = `https://www.youtube-nocookie.com/embed/${YT}`;
const YT_THUMB = `https://i.ytimg.com/vi/${YT}/hqdefault.jpg`;

describe('planLink: YouTube', () => {
  it('rewrites watch links to the no-cookie embed and a thumbnail', () => {
    const plan = planLink(`https://www.youtube.com/watch?v=${YT}`);
    expect(plan).toEqual({
      ok: true,
      kind: 'youtube',
      url: `https://www.youtube.com/watch?v=${YT}`,
      embedUrl: YT_EMBED,
      thumbUrl: YT_THUMB,
    });
  });

  it('drops extra parameters such as the playlist and start time', () => {
    const plan = planLink(`https://www.youtube.com/watch?feature=share&list=PL123&v=${YT}&t=42s`);
    expect(plan).toMatchObject({ ok: true, kind: 'youtube', embedUrl: YT_EMBED, thumbUrl: YT_THUMB });
  });

  it('handles youtu.be short links with a tracking parameter', () => {
    expect(planLink(`https://youtu.be/${YT}?si=abcdef`)).toMatchObject({
      ok: true, kind: 'youtube', embedUrl: YT_EMBED, thumbUrl: YT_THUMB,
    });
  });

  it('handles shorts links', () => {
    expect(planLink(`https://www.youtube.com/shorts/${YT}?feature=share`)).toMatchObject({
      ok: true, kind: 'youtube', embedUrl: YT_EMBED, thumbUrl: YT_THUMB,
    });
  });

  it('handles the mobile and bare youtube.com hosts', () => {
    expect(planLink(`https://m.youtube.com/watch?v=${YT}&pp=x`)).toMatchObject({ kind: 'youtube', embedUrl: YT_EMBED });
    expect(planLink(`https://youtube.com/watch?v=${YT}`)).toMatchObject({ kind: 'youtube', embedUrl: YT_EMBED });
  });

  it('keeps the original link for Open in new tab', () => {
    const plan = planLink(`  https://youtu.be/${YT}  `);
    expect(plan).toMatchObject({ ok: true, url: `https://youtu.be/${YT}` });
  });

  it('treats a YouTube link without a valid video id as generic', () => {
    for (const link of [
      'https://www.youtube.com/watch',
      'https://www.youtube.com/watch?v=short',
      'https://www.youtube.com/feed/subscriptions',
      'https://youtu.be/',
      'https://www.youtube.com/@somechannel',
    ]) {
      expect(planLink(link)).toMatchObject({ ok: true, kind: 'generic', thumbUrl: null });
    }
  });

  it('does not treat look-alike hosts as YouTube', () => {
    expect(planLink(`https://youtube.com.evil.example/watch?v=${YT}`)).toMatchObject({ kind: 'generic' });
    expect(planLink(`https://notyoutu.be/${YT}`)).toMatchObject({ kind: 'generic' });
  });
});

describe('planLink: Claude artifacts', () => {
  it('rewrites a published artifact to its /embed URL', () => {
    expect(planLink('https://claude.ai/public/artifacts/abc-123_XYZ')).toEqual({
      ok: true,
      kind: 'claude-published',
      url: 'https://claude.ai/public/artifacts/abc-123_XYZ',
      embedUrl: 'https://claude.ai/public/artifacts/abc-123_XYZ/embed',
      thumbUrl: null,
    });
  });

  it('accepts a trailing slash and drops query and fragment from the embed URL', () => {
    expect(planLink('https://claude.ai/public/artifacts/abc-123/?utm=1#x')).toMatchObject({
      kind: 'claude-published',
      embedUrl: 'https://claude.ai/public/artifacts/abc-123/embed',
    });
  });

  it('keeps a URL that already ends in /embed', () => {
    expect(planLink('https://claude.ai/public/artifacts/abc-123/embed')).toEqual({
      ok: true,
      kind: 'claude-published',
      url: 'https://claude.ai/public/artifacts/abc-123/embed',
      embedUrl: 'https://claude.ai/public/artifacts/abc-123/embed',
      thumbUrl: null,
    });
  });

  it('marks claude.ai/artifact/<id> as not embeddable', () => {
    expect(planLink('https://claude.ai/artifact/abc-123')).toEqual({
      ok: true,
      kind: 'claude-new',
      url: 'https://claude.ai/artifact/abc-123',
      embedUrl: null,
      thumbUrl: null,
    });
  });

  it('marks claude.ai/code/artifact/<id> as not embeddable', () => {
    expect(planLink('https://claude.ai/code/artifact/0f8fad5b-d9cb-469f-a165-70867728950e')).toMatchObject({
      ok: true,
      kind: 'claude-new',
      embedUrl: null,
      thumbUrl: null,
    });
  });

  it('treats other claude.ai paths and look-alike hosts as generic', () => {
    for (const link of [
      'https://claude.ai/chat/123',
      'https://claude.ai/public/artifacts/',
      'https://claude.ai/public/artifacts/abc/other',
      'https://claude.ai/artifact/',
      'https://claude.ai/artifact/abc/extra',
      'https://claude.ai.evil.example/public/artifacts/abc',
      'https://example.com/public/artifacts/abc',
    ]) {
      expect(planLink(link)).toMatchObject({ ok: true, kind: 'generic' });
    }
  });
});
```

- [ ] **Step 6: Run it and confirm the new tests fail**

Run: `npm test -w shared -- urls`
Expected: FAIL, `Tests  10 failed | 20 passed (30)`. The ten failures are the YouTube rewrite tests (watch, extra parameters, `youtu.be`, shorts, mobile and bare hosts) and the Claude tests (published, trailing slash, `/embed`, `claude.ai/artifact`, `claude.ai/code/artifact`); the four "stays generic" tests already pass.

- [ ] **Step 7: Replace `shared/src/urls.ts` with the complete version**

Replace the whole file (it now adds the YouTube and Claude rewrites):

```ts
import { LIMITS } from './constants';

export type LinkPlan =
  | { ok: true; kind: 'generic' | 'youtube' | 'claude-published'; url: string; embedUrl: string; thumbUrl: string | null }
  | { ok: true; kind: 'claude-new'; url: string; embedUrl: null; thumbUrl: null }
  | { ok: false; reason: 'invalid' | 'scheme' | 'host' | 'too_long' };

export const NOTES = {
  claudeNew: "Newer Claude artifacts can't be embedded and need a Claude account to open. Upload the artifact's HTML file instead.",
  claudeAllow: (boardHost: string): string =>
    `Add ${boardHost} to this artifact's Allowed domains in Claude (Publish → Get embed code) to show it live.`,
  blocked: "This site doesn't allow embedding. Open it in a new tab.",
};

const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;
const YT_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const CLAUDE_ID_RE = /^[A-Za-z0-9_-]+$/;
const YT_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com']);
const YT_SHORT_HOSTS = new Set(['youtu.be', 'www.youtu.be']);
const CLAUDE_HOSTS = new Set(['claude.ai', 'www.claude.ai']);

/** True for hosts a class board must never load: IP literals and local or internal names. */
function isBlockedHost(hostname: string): boolean {
  // new URL() has already normalized numeric hosts such as 2130706433 or 0x7f.1 to dotted IPv4.
  if (hostname.startsWith('[') || IPV4_RE.test(hostname)) return true;
  const host = hostname.replace(/\.$/, '');
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  );
}

function youtubeId(u: URL): string | null {
  const parts = u.pathname.split('/').filter(Boolean);
  let id: string | null | undefined = null;
  if (YT_SHORT_HOSTS.has(u.hostname)) id = parts[0];
  else if (YT_HOSTS.has(u.hostname)) {
    if (parts[0] === 'watch') id = u.searchParams.get('v');
    else if (parts[0] === 'shorts') id = parts[1];
  }
  return id && YT_ID_RE.test(id) ? id : null;
}

/** Matches claude.ai artifact links, including published ones that already end in /embed. */
function claudeArtifact(u: URL): { id: string; kind: 'published' | 'new' } | null {
  if (!CLAUDE_HOSTS.has(u.hostname)) return null;
  const parts = u.pathname.split('/').filter(Boolean);
  if (parts[0] === 'public' && parts[1] === 'artifacts') {
    const id = parts[2];
    const tail = parts.slice(3);
    const tailOk = tail.length === 0 || (tail.length === 1 && tail[0] === 'embed');
    return id && CLAUDE_ID_RE.test(id) && tailOk ? { id, kind: 'published' } : null;
  }
  const at = parts[0] === 'artifact' ? 1 : parts[0] === 'code' && parts[1] === 'artifact' ? 2 : -1;
  const id = at > 0 ? parts[at] : undefined;
  return id && CLAUDE_ID_RE.test(id) && parts.length === at + 1 ? { id, kind: 'new' } : null;
}

export function planLink(input: string): LinkPlan {
  if (typeof input !== 'string') return { ok: false, reason: 'invalid' };
  const trimmed = input.trim();
  if (trimmed.length > LIMITS.urlMax) return { ok: false, reason: 'too_long' };
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, reason: 'scheme' };
  if (isBlockedHost(u.hostname)) return { ok: false, reason: 'host' };

  const url = u.href;
  const yt = youtubeId(u);
  if (yt) {
    return {
      ok: true,
      kind: 'youtube',
      url,
      embedUrl: `https://www.youtube-nocookie.com/embed/${yt}`,
      thumbUrl: `https://i.ytimg.com/vi/${yt}/hqdefault.jpg`,
    };
  }
  const claude = claudeArtifact(u);
  if (claude?.kind === 'published') {
    return {
      ok: true,
      kind: 'claude-published',
      url,
      embedUrl: `https://claude.ai/public/artifacts/${claude.id}/embed`,
      thumbUrl: null,
    };
  }
  if (claude?.kind === 'new') return { ok: true, kind: 'claude-new', url, embedUrl: null, thumbUrl: null };
  return { ok: true, kind: 'generic', url, embedUrl: url, thumbUrl: null };
}

/** The origin of an http(s) URL, or null for anything else (including unparsable input). */
export function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 8: Run the test and confirm it passes**

Run: `npm test -w shared -- urls`
Expected: PASS, `Tests  30 passed (30)`.

- [ ] **Step 9: Commit (orchestrator)**

```bash
git add shared/src/urls.ts shared/test/urls.test.ts
git commit -m "feat(shared): link planning and rewrites (F4)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task F5: Pixel-art codec and message validation

**Wave:** 2 · **Tier:** T1 (sonnet, low) · **Depends on:** F1, F2

**Files:**
- Create: `shared/src/pixelArt.ts`, `shared/src/protocol.ts`
- Test: `shared/test/pixelArt.test.ts`, `shared/test/protocol.test.ts`

Implements the `shared/src/pixelArt.ts` and `shared/src/protocol.ts` exports in master plan §3.1, using valibot 1.5.0. Decisions the contract leaves open, all covered by tests:

- **Codec:** 256 cells at 4 bits each is 128 bytes, which is standard padded base64 of exactly 172 characters (171 characters plus one `=`). `encodeArt` throws a `RangeError` for a grid of the wrong size or a value above `ART_MAX_INDEX`. `decodeArt` returns `null` unless the string is canonical base64 of exactly that length with every nibble at most `ART_MAX_INDEX`, so one drawing has exactly one string.
- **`cleanText`:** a run of control and whitespace characters becomes one space when it contains real whitespace (`a\nb` gives `a b`) and disappears otherwise (`a\u0001b` gives `ab`). The cut counts characters (code points), so an emoji is never split.
- **Text limits:** name and label text longer than 200 raw characters makes the message invalid; anything shorter is cleaned and then cut to `LIMITS.nameMax` or `LIMITS.labelMax`. A name must be non-empty after cleaning; a label may be empty. Extra fields are dropped everywhere.
- **`cursor` messages:** coordinates must be finite numbers; they are rounded to integers and clamped to plus or minus 100,000.
- **`teacher` messages:** the `code` is not cleaned. `clear` requires a valid `slot`, `resetCursor` requires a `target` connection id, and `check`, `lock` and `unlock` drop any `slot` or `target` sent with them.
- **Ids and slots:** slot numbers are checked inline as integers from 0 to `SLOT_COUNT - 1`, so this task does not import `slots.ts` and can run alongside F3. `clientId`, `reqId` and `target` match `[A-Za-z0-9_-]{1,64}`, an upload `fileId` is 32 lowercase hex characters, `baseVersion` is an integer of at least 0, and `versionId` an integer of at least 1. A link `url` may be up to 4,096 characters here; `planLink` reports `too_long` beyond `LIMITS.urlMax`. A string message over 16,384 characters is rejected without parsing.
- **`isValidProfile`:** true when the name is non-empty after cleaning (so `'  Ana\n'` is valid), the color is one of `COLORS`, and the cursor is valid.
- **`defaultProfile(name)`:** cleans the name and falls back to `Guest` when nothing is left.

- [ ] **Step 1: Write the failing pixel-art test**

`shared/test/pixelArt.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ART_FIXED_COLORS, ART_MAX_INDEX, ART_SIZE } from '../src/constants';
import {
  decodeArt, emptyGrid, encodeArt, isValidArt, isValidTip, paletteColors,
} from '../src/pixelArt';

const CELLS = ART_SIZE * ART_SIZE;

/** Deterministic pseudo-random grid (LCG), so failures reproduce. */
function randomGrid(seed: number): Uint8Array {
  const grid = emptyGrid();
  let s = seed;
  for (let i = 0; i < CELLS; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    grid[i] = (s >>> 16) % (ART_MAX_INDEX + 1);
  }
  return grid;
}

/** Encodes raw bytes the way encodeArt does, but without validating nibbles. */
function rawArt(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

describe('emptyGrid', () => {
  it('has 256 transparent cells', () => {
    const grid = emptyGrid();
    expect(grid).toBeInstanceOf(Uint8Array);
    expect(grid).toHaveLength(CELLS);
    expect(grid.every((v) => v === 0)).toBe(true);
  });

  it('returns a fresh array each time', () => {
    const a = emptyGrid();
    a[0] = 3;
    expect(emptyGrid()[0]).toBe(0);
  });
});

describe('encodeArt and decodeArt', () => {
  it('encodes to exactly 172 characters of padded base64', () => {
    for (const grid of [emptyGrid(), randomGrid(1), randomGrid(2)]) {
      const art = encodeArt(grid);
      expect(art).toHaveLength(172);
      expect(art).toMatch(/^[A-Za-z0-9+/]{171}=$/);
    }
  });

  it('packs two cells per byte with the even cell in the high nibble', () => {
    const grid = emptyGrid();
    grid[0] = 1;
    grid[1] = 8;
    grid[2] = 2;
    grid[3] = 0;
    const bytes = Uint8Array.from(atob(encodeArt(grid)), (c) => c.charCodeAt(0));
    expect(bytes).toHaveLength(128);
    expect(bytes[0]).toBe(0x18);
    expect(bytes[1]).toBe(0x20);
    expect(bytes[2]).toBe(0);
  });

  it('encodes an empty grid as all A characters plus padding', () => {
    expect(encodeArt(emptyGrid())).toBe('A'.repeat(171) + '=');
  });

  it('round-trips random grids exactly', () => {
    for (let seed = 1; seed <= 25; seed++) {
      const grid = randomGrid(seed);
      expect(decodeArt(encodeArt(grid))).toEqual(grid);
    }
  });

  it('round-trips a grid that uses every palette index', () => {
    const grid = emptyGrid();
    for (let i = 0; i < CELLS; i++) grid[i] = i % (ART_MAX_INDEX + 1);
    expect(decodeArt(encodeArt(grid))).toEqual(grid);
  });

  it('refuses to encode a grid of the wrong size', () => {
    expect(() => encodeArt(new Uint8Array(255))).toThrow(RangeError);
    expect(() => encodeArt(new Uint8Array(257))).toThrow(RangeError);
  });

  it('refuses to encode a value above the palette', () => {
    const grid = emptyGrid();
    grid[100] = ART_MAX_INDEX + 1;
    expect(() => encodeArt(grid)).toThrow(RangeError);
  });

  it('rejects strings that are not valid base64', () => {
    expect(decodeArt('!'.repeat(172))).toBeNull();
    expect(decodeArt('A'.repeat(170) + '=!')).toBeNull();
    expect(decodeArt('A'.repeat(172))).toBeNull();
    expect(decodeArt('A'.repeat(169) + '===')).toBeNull();
    expect(decodeArt('-'.repeat(171) + '=')).toBeNull();
  });

  it('rejects strings of the wrong length', () => {
    const good = encodeArt(randomGrid(3));
    expect(decodeArt('')).toBeNull();
    expect(decodeArt(good.slice(0, 171))).toBeNull();
    expect(decodeArt(good + 'A')).toBeNull();
    expect(decodeArt('A'.repeat(168))).toBeNull();
  });

  it('rejects values above the palette in either nibble', () => {
    const high = new Uint8Array(128);
    high[5] = 0x90;
    expect(decodeArt(rawArt(high))).toBeNull();
    const low = new Uint8Array(128);
    low[5] = 0x0f;
    expect(decodeArt(rawArt(low))).toBeNull();
    const max = new Uint8Array(128);
    max[5] = (ART_MAX_INDEX << 4) | ART_MAX_INDEX;
    expect(decodeArt(rawArt(max))).not.toBeNull();
  });

  it('rejects non-canonical base64 with stray bits in the padding', () => {
    const good = encodeArt(randomGrid(4));
    // The last character before "=" carries 2 unused bits; flipping one changes the text, not the bytes.
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const last = good[170]!;
    const flipped = alphabet[alphabet.indexOf(last) ^ 1]!;
    expect(decodeArt(good.slice(0, 170) + flipped + '=')).toBeNull();
  });

  it('returns null for non-string input', () => {
    expect(decodeArt(undefined as unknown as string)).toBeNull();
    expect(decodeArt(42 as unknown as string)).toBeNull();
  });
});

describe('isValidArt', () => {
  it('accepts encoded grids and rejects everything else', () => {
    expect(isValidArt(encodeArt(randomGrid(7)))).toBe(true);
    expect(isValidArt(encodeArt(emptyGrid()))).toBe(true);
    expect(isValidArt('nope')).toBe(false);
    expect(isValidArt('')).toBe(false);
    expect(isValidArt('A'.repeat(172))).toBe(false);
  });
});

describe('isValidTip', () => {
  it('accepts integer pairs from 0 to 15', () => {
    expect(isValidTip([0, 0])).toBe(true);
    expect(isValidTip([8, 8])).toBe(true);
    expect(isValidTip([15, 15])).toBe(true);
  });

  it('rejects out-of-range, fractional, non-numeric and wrongly shaped tips', () => {
    for (const bad of [
      [16, 0], [0, 16], [-1, 0], [0, -1], [1.5, 2], [NaN, 0], [Infinity, 0], ['1', 2],
      [1], [1, 2, 3], [], null, undefined, 'ab', { 0: 1, 1: 2 }, 8,
    ]) {
      expect(isValidTip(bad)).toBe(false);
    }
  });
});

describe('paletteColors', () => {
  it('lists transparent, the profile color, then the fixed colors', () => {
    const palette = paletteColors('#D85A30');
    expect(palette).toHaveLength(ART_MAX_INDEX + 1);
    expect(palette[0]).toBeNull();
    expect(palette[1]).toBe('#D85A30');
    expect(palette.slice(2)).toEqual([...ART_FIXED_COLORS]);
  });

  it('recolors index 1 with the profile color and nothing else', () => {
    const a = paletteColors('#111111');
    const b = paletteColors('#222222');
    expect(a[1]).not.toBe(b[1]);
    expect(a.filter((_, i) => i !== 1)).toEqual(b.filter((_, i) => i !== 1));
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npm test -w shared -- pixelArt`
Expected: FAIL, `Cannot find module '../src/pixelArt' imported from .../shared/test/pixelArt.test.ts`.

- [ ] **Step 3: Implement `shared/src/pixelArt.ts`**

```ts
import { ART_FIXED_COLORS, ART_MAX_INDEX, ART_SIZE } from './constants';

/** ART_SIZE * ART_SIZE cells, row-major, each 0..ART_MAX_INDEX (0 = transparent, 1 = profile color). */
export type PixelGrid = Uint8Array;

const CELLS = ART_SIZE * ART_SIZE;
const BYTES = CELLS / 2;
/** 128 bytes as padded base64: 42 full groups plus a 2-byte tail. */
const ART_CHARS = Math.ceil(BYTES / 3) * 4;
const BASE64_RE = new RegExp(`^[A-Za-z0-9+/]{${ART_CHARS - 1}}=$`);

export function emptyGrid(): PixelGrid {
  return new Uint8Array(CELLS);
}

export function encodeArt(grid: PixelGrid): string {
  if (grid.length !== CELLS) throw new RangeError(`Pixel grid must have ${CELLS} cells, got ${grid.length}`);
  let binary = '';
  for (let i = 0; i < CELLS; i += 2) {
    const hi = grid[i]!;
    const lo = grid[i + 1]!;
    if (hi > ART_MAX_INDEX || lo > ART_MAX_INDEX) {
      throw new RangeError(`Pixel values must be 0..${ART_MAX_INDEX}`);
    }
    binary += String.fromCharCode((hi << 4) | lo);
  }
  return btoa(binary);
}

export function decodeArt(art: string): PixelGrid | null {
  if (typeof art !== 'string' || art.length !== ART_CHARS || !BASE64_RE.test(art)) return null;
  let binary: string;
  try {
    binary = atob(art);
  } catch {
    return null;
  }
  if (binary.length !== BYTES) return null;
  const grid = emptyGrid();
  for (let i = 0; i < BYTES; i++) {
    const byte = binary.charCodeAt(i);
    const hi = byte >> 4;
    const lo = byte & 0x0f;
    if (hi > ART_MAX_INDEX || lo > ART_MAX_INDEX) return null;
    grid[i * 2] = hi;
    grid[i * 2 + 1] = lo;
  }
  // Reject non-canonical base64 (stray bits in the padding) so one drawing has one string.
  return encodeArt(grid) === art ? grid : null;
}

export function isValidArt(art: string): boolean {
  return decodeArt(art) !== null;
}

export function isValidTip(tip: unknown): tip is [number, number] {
  return (
    Array.isArray(tip) &&
    tip.length === 2 &&
    tip.every((n) => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n < ART_SIZE)
  );
}

/** Palette by cell value: index 0 is transparent (null), 1 is the profile color, then the fixed colors. */
export function paletteColors(profileColor: string): Array<string | null> {
  return [null, profileColor, ...ART_FIXED_COLORS];
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npm test -w shared -- pixelArt`
Expected: PASS, `Tests  19 passed (19)`.

- [ ] **Step 5: Write the failing test for `cleanText`, `defaultProfile` and `isValidProfile`**

`shared/test/protocol.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { COLORS, LIMITS } from '../src/constants';
import { emptyGrid, encodeArt } from '../src/pixelArt';
import { cleanText, defaultProfile, isValidProfile } from '../src/protocol';
import type { Profile } from '../src/types';

const ART = encodeArt(emptyGrid());

const shapeProfile: Profile = { name: 'Ana', color: COLORS[3], cursor: { kind: 'shape', shape: 'star' } };
const pixelProfile: Profile = { name: 'Ben', color: COLORS[0], cursor: { kind: 'pixels', art: ART, tip: [8, 8] } };

describe('cleanText', () => {
  it('removes control characters', () => {
    expect(cleanText('a\u0000b\u0007c\u001fd\u007fe\u0085f', 40)).toBe('abcdef');
  });

  it('turns tabs and newlines into single spaces', () => {
    expect(cleanText('one\ntwo\t\tthree\r\nfour', 40)).toBe('one two three four');
  });

  it('collapses whitespace runs, including ones mixed with control characters', () => {
    expect(cleanText('a   b \u0001 c  d', 40)).toBe('a b c d');
  });

  it('trims both ends', () => {
    expect(cleanText('  \t hello \n ', 40)).toBe('hello');
    expect(cleanText('\u0001\u0002', 40)).toBe('');
    expect(cleanText('   ', 40)).toBe('');
  });

  it('cuts to the maximum number of characters and trims what the cut exposes', () => {
    expect(cleanText('abcdefghij', 4)).toBe('abcd');
    expect(cleanText('abc defgh', 4)).toBe('abc');
  });

  it('counts an emoji as one character and never splits it', () => {
    expect(cleanText('😀😀😀😀', 2)).toBe('😀😀');
    expect(cleanText('ab😀', 3)).toBe('ab😀');
  });

  it('leaves clean text alone', () => {
    expect(cleanText('Maya R.', 24)).toBe('Maya R.');
  });
});

describe('defaultProfile', () => {
  it('is a guest with the first color and the arrow', () => {
    expect(defaultProfile()).toEqual({
      name: 'Guest', color: COLORS[0], cursor: { kind: 'shape', shape: 'arrow' },
    });
  });

  it('uses the given name, cleaned and cut to the limit', () => {
    expect(defaultProfile('  Ana \n').name).toBe('Ana');
    expect(defaultProfile('x'.repeat(50)).name).toHaveLength(LIMITS.nameMax);
  });

  it('falls back to Guest when the name cleans to nothing', () => {
    expect(defaultProfile('\u0001 ').name).toBe('Guest');
  });

  it('produces a valid profile', () => {
    expect(isValidProfile(defaultProfile())).toBe(true);
  });
});

describe('isValidProfile', () => {
  it('accepts shape and pixel cursors', () => {
    expect(isValidProfile(shapeProfile)).toBe(true);
    expect(isValidProfile(pixelProfile)).toBe(true);
  });

  it('accepts every color and every shape', () => {
    for (const color of COLORS) expect(isValidProfile({ ...shapeProfile, color })).toBe(true);
    for (const shape of ['arrow', 'hand', 'pencil', 'star', 'plane', 'crosshair']) {
      expect(isValidProfile({ ...shapeProfile, cursor: { kind: 'shape', shape } })).toBe(true);
    }
  });

  it('accepts a name that only needs cleaning, and rejects one that cleans to nothing', () => {
    expect(isValidProfile({ ...shapeProfile, name: '  Ana\n' })).toBe(true);
    expect(isValidProfile({ ...shapeProfile, name: '' })).toBe(false);
    expect(isValidProfile({ ...shapeProfile, name: ' \t\u0001 ' })).toBe(false);
  });

  it('rejects a name far beyond the limit', () => {
    expect(isValidProfile({ ...shapeProfile, name: 'x'.repeat(1000) })).toBe(false);
  });

  it('rejects colors outside the palette', () => {
    expect(isValidProfile({ ...shapeProfile, color: '#000000' })).toBe(false);
    expect(isValidProfile({ ...shapeProfile, color: 'red' })).toBe(false);
    expect(isValidProfile({ ...shapeProfile, color: COLORS[0].toLowerCase() })).toBe(false);
  });

  it('rejects unknown shapes and cursor kinds', () => {
    expect(isValidProfile({ ...shapeProfile, cursor: { kind: 'shape', shape: 'emoji' } })).toBe(false);
    expect(isValidProfile({ ...shapeProfile, cursor: { kind: 'image', url: 'x' } })).toBe(false);
    expect(isValidProfile({ ...shapeProfile, cursor: null })).toBe(false);
  });

  it('rejects pixel cursors with bad art or a bad tip', () => {
    const px = (art: unknown, tip: unknown) => ({ ...shapeProfile, cursor: { kind: 'pixels', art, tip } });
    expect(isValidProfile(px(ART, [8, 8]))).toBe(true);
    expect(isValidProfile(px('short', [8, 8]))).toBe(false);
    expect(isValidProfile(px(ART.slice(1) + 'A', [8, 8]))).toBe(false);
    expect(isValidProfile(px(ART, [16, 8]))).toBe(false);
    expect(isValidProfile(px(ART, [-1, 8]))).toBe(false);
    expect(isValidProfile(px(ART, [1.5, 8]))).toBe(false);
    expect(isValidProfile(px(ART, [8]))).toBe(false);
    expect(isValidProfile(px(ART, [8, 8, 8]))).toBe(false);
    expect(isValidProfile(px(ART, '8,8'))).toBe(false);
    expect(isValidProfile(px(undefined, [8, 8]))).toBe(false);
  });

  it('rejects values that are not profiles', () => {
    for (const bad of [null, undefined, 'Ana', 42, [], {}, { name: 'Ana' }]) {
      expect(isValidProfile(bad)).toBe(false);
    }
  });
});
```

- [ ] **Step 6: Run it and confirm it fails**

Run: `npm test -w shared -- protocol`
Expected: FAIL, `Cannot find module '../src/protocol' imported from .../shared/test/protocol.test.ts`.

- [ ] **Step 7: Implement the text and profile half of `shared/src/protocol.ts`**

`shared/src/protocol.ts`:

```ts
import * as v from 'valibot';
import { COLORS, LIMITS, SHAPES } from './constants';
import { isValidArt, isValidTip } from './pixelArt';
import type { Profile } from './types';

/** Raw text longer than this is rejected outright; shorter text is cleaned and cut to its field limit. */
const RAW_TEXT_MAX = 200;

/** Removes control characters, collapses whitespace runs to one space, trims, and cuts to `max` characters. */
export function cleanText(s: string, max: number): string {
  // A run of control and whitespace characters becomes one space if it contains real whitespace, else nothing.
  const collapsed = s.replace(/[\p{Cc}\s]+/gu, (run) => (/\s/u.test(run) ? ' ' : '')).trim();
  return Array.from(collapsed).slice(0, max).join('').trimEnd();
}

export function defaultProfile(name?: string): Profile {
  return {
    name: cleanText(name ?? 'Guest', LIMITS.nameMax) || 'Guest',
    color: COLORS[0],
    cursor: { kind: 'shape', shape: 'arrow' },
  };
}

const cleanedText = (max: number) =>
  v.pipe(v.string(), v.maxLength(RAW_TEXT_MAX), v.transform((s) => cleanText(s, max)));

const cursorSchema = v.variant('kind', [
  v.object({ kind: v.literal('shape'), shape: v.picklist(SHAPES) }),
  v.object({
    kind: v.literal('pixels'),
    art: v.pipe(v.string(), v.check((art) => isValidArt(art), 'Invalid pixel art')),
    tip: v.pipe(v.strictTuple([v.number(), v.number()]), v.check((tip) => isValidTip(tip), 'Invalid cursor tip')),
  }),
]);

const profileSchema = v.object({
  name: v.pipe(cleanedText(LIMITS.nameMax), v.minLength(1)),
  color: v.picklist(COLORS),
  cursor: cursorSchema,
});

export function isValidProfile(p: unknown): p is Profile {
  return v.safeParse(profileSchema, p).success;
}
```

- [ ] **Step 8: Run the test and confirm it passes**

Run: `npm test -w shared -- protocol`
Expected: PASS, `Tests  19 passed (19)`.

- [ ] **Step 9: Add the failing tests for `parseClientMsg`**

In `shared/test/protocol.test.ts`, replace the import block at the top (lines 1 to 5):

```ts
import { describe, expect, it } from 'vitest';
import { COLORS, LIMITS } from '../src/constants';
import { emptyGrid, encodeArt } from '../src/pixelArt';
import { cleanText, defaultProfile, isValidProfile } from '../src/protocol';
import type { Profile } from '../src/types';
```

with:

```ts
import { describe, expect, it } from 'vitest';
import { COLORS, LIMITS } from '../src/constants';
import { emptyGrid, encodeArt } from '../src/pixelArt';
import { cleanText, defaultProfile, isValidProfile, parseClientMsg } from '../src/protocol';
import type { ClientMsg, Profile } from '../src/types';
```

Then append this to the end of the file, leaving one blank line after the last `});`:

```ts
const FILE_ID = 'a'.repeat(32);

/** Every message type in its smallest valid form. */
const valid: Record<ClientMsg['type'], ClientMsg> = {
  hello: { type: 'hello', clientId: 'b3d1c0de-1234-4abc-9def-0123456789ab', profile: shapeProfile },
  profile: { type: 'profile', profile: pixelProfile },
  cursor: { type: 'cursor', x: 120, y: -40 },
  dock: { type: 'dock', slot: 23, mode: 'using' },
  away: { type: 'away' },
  post: {
    type: 'post', reqId: 'abc123def456', slot: 0, baseVersion: 0,
    content: { kind: 'link', url: 'https://example.com/' }, label: 'Ana',
  },
  rename: { type: 'rename', reqId: 'abc123def456', slot: 79, baseVersion: 4, label: 'New name' },
  restore: { type: 'restore', reqId: 'abc123def456', slot: 5, baseVersion: 9, versionId: 3 },
  history: { type: 'history', reqId: 'abc123def456', slot: 12 },
  teacher: { type: 'teacher', reqId: 'abc123def456', code: 'letmein', action: 'lock' },
};

describe('parseClientMsg: input handling', () => {
  it('parses every message type from an object', () => {
    for (const msg of Object.values(valid)) expect(parseClientMsg(msg)).toEqual(msg);
  });

  it('parses every message type from a JSON string', () => {
    for (const msg of Object.values(valid)) expect(parseClientMsg(JSON.stringify(msg))).toEqual(msg);
  });

  it('returns null for invalid JSON and for JSON that is not an object', () => {
    for (const bad of ['', '{', 'not json', 'null', '42', '"cursor"', '[]', '[{"type":"away"}]', 'true']) {
      expect(parseClientMsg(bad)).toBeNull();
    }
  });

  it('returns null for non-object input of any kind', () => {
    for (const bad of [null, undefined, 42, true, [], [valid.away], new ArrayBuffer(8), () => {}]) {
      expect(parseClientMsg(bad)).toBeNull();
    }
  });

  it('returns null for an oversized string without parsing it', () => {
    const big = JSON.stringify({ type: 'away', pad: 'x'.repeat(20_000) });
    expect(parseClientMsg(big)).toBeNull();
  });

  it('returns null for an unknown or missing type', () => {
    expect(parseClientMsg({ type: 'explode' })).toBeNull();
    expect(parseClientMsg({ type: 'snapshot' })).toBeNull();
    expect(parseClientMsg({ type: 7 })).toBeNull();
    expect(parseClientMsg({})).toBeNull();
    expect(parseClientMsg({ x: 1, y: 2 })).toBeNull();
  });

  it('drops fields the protocol does not define', () => {
    expect(parseClientMsg({ ...valid.cursor, extra: 'x', __proto__: { admin: true } })).toEqual(valid.cursor);
    expect(parseClientMsg({ ...valid.away, junk: 1 })).toEqual({ type: 'away' });
    expect(parseClientMsg({ ...valid.hello, isTeacher: true })).toEqual(valid.hello);
    const post = valid.post as Extract<ClientMsg, { type: 'post' }>;
    expect(parseClientMsg({ ...post, content: { kind: 'link', url: 'https://example.com/', evil: 1 } })).toEqual(post);
    expect(parseClientMsg({ ...valid.hello, profile: { ...shapeProfile, role: 'teacher' } })).toEqual(valid.hello);
  });
});

describe('parseClientMsg: hello and profile', () => {
  it('cleans the profile name', () => {
    const parsed = parseClientMsg({ ...valid.hello, profile: { ...shapeProfile, name: '  A\u0000na \n B ' } });
    expect(parsed).toMatchObject({ type: 'hello', profile: { name: 'Ana B' } });
  });

  it('cuts a long profile name to the limit', () => {
    const parsed = parseClientMsg({ type: 'profile', profile: { ...shapeProfile, name: 'y'.repeat(60) } });
    expect(parsed).toMatchObject({ type: 'profile', profile: { name: 'y'.repeat(LIMITS.nameMax) } });
  });

  it('rejects a hello without a valid client id', () => {
    const { clientId: _unused, ...missing } = valid.hello as Extract<ClientMsg, { type: 'hello' }>;
    expect(parseClientMsg(missing)).toBeNull();
    for (const clientId of ['', 'has space', 'x'.repeat(65), 12, null, '<script>']) {
      expect(parseClientMsg({ ...valid.hello, clientId })).toBeNull();
    }
  });

  it('rejects hello and profile messages with an invalid profile', () => {
    expect(parseClientMsg({ type: 'hello', clientId: 'abcdefgh' })).toBeNull();
    expect(parseClientMsg({ type: 'hello', clientId: 'abcdefgh', profile: { ...shapeProfile, name: '' } })).toBeNull();
    expect(parseClientMsg({ type: 'profile', profile: { ...shapeProfile, color: '#123456' } })).toBeNull();
    expect(parseClientMsg({ type: 'profile', profile: { ...pixelProfile, cursor: { kind: 'pixels', art: 'x', tip: [8, 8] } } })).toBeNull();
    expect(parseClientMsg({ type: 'profile', profile: { ...pixelProfile, cursor: { kind: 'pixels', art: ART, tip: [99, 8] } } })).toBeNull();
    expect(parseClientMsg({ type: 'profile' })).toBeNull();
  });

  it('keeps a pixel cursor exactly as sent', () => {
    expect(parseClientMsg(valid.profile)).toEqual(valid.profile);
  });
});

describe('parseClientMsg: cursor and dock', () => {
  it('rounds cursor coordinates to integers', () => {
    expect(parseClientMsg({ type: 'cursor', x: 10.6, y: -3.4 })).toEqual({ type: 'cursor', x: 11, y: -3 });
  });

  it('clamps cursor coordinates to a sane range', () => {
    expect(parseClientMsg({ type: 'cursor', x: 1e12, y: -1e12 })).toEqual({ type: 'cursor', x: 100_000, y: -100_000 });
  });

  it('rejects cursor messages with missing, non-finite or non-numeric coordinates', () => {
    for (const bad of [
      { type: 'cursor', x: 1 },
      { type: 'cursor', y: 1 },
      { type: 'cursor', x: NaN, y: 1 },
      { type: 'cursor', x: 1, y: Infinity },
      { type: 'cursor', x: '1', y: 2 },
      { type: 'cursor', x: null, y: 2 },
    ]) {
      expect(parseClientMsg(bad)).toBeNull();
    }
  });

  it('accepts dock messages for both modes and every corner slot', () => {
    for (const slot of [0, 9, 70, 79]) {
      for (const mode of ['using', 'viewing'] as const) {
        expect(parseClientMsg({ type: 'dock', slot, mode })).toEqual({ type: 'dock', slot, mode });
      }
    }
  });

  it('rejects dock messages with an out-of-range slot or unknown mode', () => {
    for (const bad of [
      { type: 'dock', slot: 80, mode: 'using' },
      { type: 'dock', slot: -1, mode: 'using' },
      { type: 'dock', slot: 1.5, mode: 'using' },
      { type: 'dock', slot: '3', mode: 'using' },
      { type: 'dock', slot: 3, mode: 'hovering' },
      { type: 'dock', slot: 3 },
      { type: 'dock', mode: 'using' },
    ]) {
      expect(parseClientMsg(bad)).toBeNull();
    }
  });
});

describe('parseClientMsg: post', () => {
  const post = valid.post as Extract<ClientMsg, { type: 'post' }>;

  it('accepts a link post and an html post', () => {
    expect(parseClientMsg(post)).toEqual(post);
    const html = { ...post, content: { kind: 'html', fileId: FILE_ID } };
    expect(parseClientMsg(html)).toEqual(html);
  });

  it('cleans the label and allows an empty one', () => {
    expect(parseClientMsg({ ...post, label: '  Ana\n\u0000R. ' })).toMatchObject({ label: 'Ana R.' });
    expect(parseClientMsg({ ...post, label: '' })).toMatchObject({ label: '' });
  });

  it('cuts a label to the limit and rejects one that is absurdly long', () => {
    expect(parseClientMsg({ ...post, label: 'z'.repeat(60) })).toMatchObject({ label: 'z'.repeat(LIMITS.labelMax) });
    expect(parseClientMsg({ ...post, label: 'z'.repeat(5000) })).toBeNull();
  });

  it('rejects a missing or malformed reqId', () => {
    const { reqId: _unused, ...missing } = post;
    expect(parseClientMsg(missing)).toBeNull();
    for (const reqId of ['', 'has space', 'x'.repeat(65), 7, null]) {
      expect(parseClientMsg({ ...post, reqId })).toBeNull();
    }
  });

  it('rejects out-of-range slots and invalid base versions', () => {
    expect(parseClientMsg({ ...post, slot: 80 })).toBeNull();
    expect(parseClientMsg({ ...post, slot: -1 })).toBeNull();
    expect(parseClientMsg({ ...post, baseVersion: -1 })).toBeNull();
    expect(parseClientMsg({ ...post, baseVersion: 1.5 })).toBeNull();
    expect(parseClientMsg({ ...post, baseVersion: '0' })).toBeNull();
    const { baseVersion: _unused, ...missing } = post;
    expect(parseClientMsg(missing)).toBeNull();
  });

  it('rejects invalid content', () => {
    for (const content of [
      undefined,
      null,
      'https://example.com',
      { kind: 'link' },
      { kind: 'link', url: '' },
      { kind: 'link', url: 42 },
      { kind: 'link', url: 'x'.repeat(5000) },
      { kind: 'html' },
      { kind: 'html', fileId: 'short' },
      { kind: 'html', fileId: 'A'.repeat(32) },
      { kind: 'html', fileId: 'g'.repeat(32) },
      { kind: 'pdf', url: 'https://example.com' },
    ]) {
      expect(parseClientMsg({ ...post, content })).toBeNull();
    }
  });

  it('passes long link text through for planLink to judge', () => {
    const url = 'https://example.com/' + 'a'.repeat(3000);
    expect(parseClientMsg({ ...post, content: { kind: 'link', url } })).toMatchObject({ content: { kind: 'link', url } });
  });
});

describe('parseClientMsg: rename, restore, history', () => {
  it('accepts rename with a cleaned label', () => {
    expect(parseClientMsg({ ...valid.rename, label: ' New\tname ' })).toMatchObject({ type: 'rename', label: 'New name' });
  });

  it('rejects rename without a label or reqId', () => {
    const { label: _l, ...noLabel } = valid.rename as Extract<ClientMsg, { type: 'rename' }>;
    const { reqId: _r, ...noReq } = valid.rename as Extract<ClientMsg, { type: 'rename' }>;
    expect(parseClientMsg(noLabel)).toBeNull();
    expect(parseClientMsg(noReq)).toBeNull();
    expect(parseClientMsg({ ...valid.rename, label: 7 })).toBeNull();
  });

  it('accepts restore and requires a positive integer version id', () => {
    expect(parseClientMsg(valid.restore)).toEqual(valid.restore);
    for (const versionId of [0, -2, 1.5, '3', null, undefined]) {
      expect(parseClientMsg({ ...valid.restore, versionId })).toBeNull();
    }
  });

  it('rejects restore with a bad slot or base version', () => {
    expect(parseClientMsg({ ...valid.restore, slot: 99 })).toBeNull();
    expect(parseClientMsg({ ...valid.restore, baseVersion: -1 })).toBeNull();
  });

  it('accepts history and rejects a bad slot or missing reqId', () => {
    expect(parseClientMsg(valid.history)).toEqual(valid.history);
    expect(parseClientMsg({ ...valid.history, slot: 80 })).toBeNull();
    expect(parseClientMsg({ type: 'history', slot: 3 })).toBeNull();
  });
});

describe('parseClientMsg: teacher', () => {
  const base = { type: 'teacher', reqId: 'abc123def456', code: 'letmein' };

  it('accepts check, lock and unlock without a slot or target', () => {
    for (const action of ['check', 'lock', 'unlock']) {
      expect(parseClientMsg({ ...base, action })).toEqual({ ...base, action });
    }
  });

  it('drops a slot or target that the action does not use', () => {
    expect(parseClientMsg({ ...base, action: 'lock', slot: 3, target: 'abc' })).toEqual({ ...base, action: 'lock' });
  });

  it('requires a valid slot for clear', () => {
    expect(parseClientMsg({ ...base, action: 'clear', slot: 12 })).toEqual({ ...base, action: 'clear', slot: 12 });
    expect(parseClientMsg({ ...base, action: 'clear' })).toBeNull();
    expect(parseClientMsg({ ...base, action: 'clear', slot: 80 })).toBeNull();
  });

  it('requires a valid target for resetCursor', () => {
    const ok = { ...base, action: 'resetCursor', target: 'conn-42' };
    expect(parseClientMsg(ok)).toEqual(ok);
    expect(parseClientMsg({ ...base, action: 'resetCursor' })).toBeNull();
    expect(parseClientMsg({ ...base, action: 'resetCursor', target: '' })).toBeNull();
    expect(parseClientMsg({ ...base, action: 'resetCursor', target: 'a b' })).toBeNull();
  });

  it('rejects unknown actions and a missing or empty code', () => {
    expect(parseClientMsg({ ...base, action: 'shutdown' })).toBeNull();
    expect(parseClientMsg({ ...base })).toBeNull();
    expect(parseClientMsg({ ...base, action: 'lock', code: '' })).toBeNull();
    expect(parseClientMsg({ ...base, action: 'lock', code: 12 })).toBeNull();
    expect(parseClientMsg({ ...base, action: 'lock', code: 'x'.repeat(500) })).toBeNull();
    const { code: _c, ...noCode } = { ...base, action: 'lock' };
    expect(parseClientMsg(noCode)).toBeNull();
  });

  it('does not clean the passcode', () => {
    expect(parseClientMsg({ ...base, action: 'lock', code: ' pass  word ' })).toMatchObject({ code: ' pass  word ' });
  });
});
```

- [ ] **Step 10: Run it and confirm the new tests fail**

Run: `npm test -w shared -- protocol`
Expected: FAIL, `Tests  35 failed | 19 passed (54)`, each failure `TypeError: parseClientMsg is not a function`.

- [ ] **Step 11: Implement `parseClientMsg`**

In `shared/src/protocol.ts`, replace the import block at the top (lines 1 to 4):

```ts
import * as v from 'valibot';
import { COLORS, LIMITS, SHAPES } from './constants';
import { isValidArt, isValidTip } from './pixelArt';
import type { Profile } from './types';
```

with:

```ts
import * as v from 'valibot';
import { COLORS, LIMITS, SHAPES, SLOT_COUNT } from './constants';
import { isValidArt, isValidTip } from './pixelArt';
import type { ClientMsg, Profile } from './types';
```

Then append this to the end of the file (after `isValidProfile`), leaving one blank line before it:

```ts

const RAW_URL_MAX = 4096;
const RAW_MESSAGE_MAX = 16_384;
/** Cursor coordinates are rounded and clamped to this many board units either side of the origin. */
const COORD_LIMIT = 100_000;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const FILE_ID_RE = /^[0-9a-f]{32}$/;

const slotSchema = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(SLOT_COUNT - 1));
const nonNegativeInt = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(Number.MAX_SAFE_INTEGER));
const reqId = v.pipe(v.string(), v.regex(ID_RE));
const label = cleanedText(LIMITS.labelMax);
const coord = v.pipe(
  v.number(),
  v.finite(),
  v.transform((n) => Math.max(-COORD_LIMIT, Math.min(COORD_LIMIT, Math.round(n)))),
);

const contentSchema = v.variant('kind', [
  v.object({
    kind: v.literal('link'),
    url: v.pipe(v.string(), v.minLength(1), v.maxLength(RAW_URL_MAX)),
  }),
  v.object({ kind: v.literal('html'), fileId: v.pipe(v.string(), v.regex(FILE_ID_RE)) }),
]);

const teacherBase = {
  type: v.literal('teacher'),
  reqId,
  code: v.pipe(v.string(), v.minLength(1), v.maxLength(RAW_TEXT_MAX)),
};

const clientMsgSchema = v.variant('type', [
  v.object({ type: v.literal('hello'), clientId: v.pipe(v.string(), v.regex(ID_RE)), profile: profileSchema }),
  v.object({ type: v.literal('profile'), profile: profileSchema }),
  v.object({ type: v.literal('cursor'), x: coord, y: coord }),
  v.object({ type: v.literal('dock'), slot: slotSchema, mode: v.picklist(['using', 'viewing']) }),
  v.object({ type: v.literal('away') }),
  v.object({
    type: v.literal('post'),
    reqId,
    slot: slotSchema,
    baseVersion: nonNegativeInt,
    content: contentSchema,
    label,
  }),
  v.object({ type: v.literal('rename'), reqId, slot: slotSchema, baseVersion: nonNegativeInt, label }),
  v.object({
    type: v.literal('restore'),
    reqId,
    slot: slotSchema,
    baseVersion: nonNegativeInt,
    versionId: v.pipe(nonNegativeInt, v.minValue(1)),
  }),
  v.object({ type: v.literal('history'), reqId, slot: slotSchema }),
  // Teacher messages carry a slot or target only for the actions that use one; valibot drops the rest.
  v.variant('action', [
    v.object({ ...teacherBase, action: v.picklist(['check', 'lock', 'unlock']) }),
    v.object({ ...teacherBase, action: v.literal('clear'), slot: slotSchema }),
    v.object({ ...teacherBase, action: v.literal('resetCursor'), target: v.pipe(v.string(), v.regex(ID_RE)) }),
  ]),
]);

export function parseClientMsg(data: unknown): ClientMsg | null {
  let value = data;
  if (typeof data === 'string') {
    if (data.length > RAW_MESSAGE_MAX) return null;
    try {
      value = JSON.parse(data);
    } catch {
      return null;
    }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const result = v.safeParse(clientMsgSchema, value);
  return result.success ? result.output : null;
}
```

- [ ] **Step 12: Run the test and confirm it passes**

Run: `npm test -w shared -- protocol`
Expected: PASS, `Tests  54 passed (54)`.

- [ ] **Step 13: Commit (orchestrator)**

```bash
git add shared/src/pixelArt.ts shared/src/protocol.ts shared/test/pixelArt.test.ts shared/test/protocol.test.ts
git commit -m "feat(shared): pixel-art codec and message validation (F5)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
