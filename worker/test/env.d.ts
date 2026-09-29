import type { Env as WorkerEnv } from '../src/env';

// Types `env` in tests (from cloudflare:test and cloudflare:workers) with the Worker's real bindings.
declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {}
  }
}
