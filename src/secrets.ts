/**
 * Secrets helpers for passing credentials into Cloudflare Containers.
 *
 * All secrets flow: Cloudflare dashboard → Worker env → container env vars.
 * Nothing is baked into the Docker image.
 *
 * Usage:
 *   import { getContainerEnv, assertRequiredSecrets } from './secrets.js';
 *
 *   assertRequiredSecrets(env);
 *   const containerEnv = getContainerEnv(env);
 *   await sandbox.startProcess('bash entrypoint.sh', { env: containerEnv });
 */

/**
 * The subset of env vars injected into every container process.
 *
 * These are read by container tools at startup:
 *   - `opencode serve` reads ANTHROPIC_API_KEY for LLM calls
 *   - `gh auth login --with-token` reads GH_TOKEN
 *   - `lb sync` reads LINEAR_API_KEY
 *   - `git config` reads GIT_AUTHOR_NAME / GIT_AUTHOR_EMAIL
 *
 * Extend this type and `getContainerEnv()` if containers need additional secrets.
 */
export interface ContainerEnv {
  ANTHROPIC_API_KEY: string;
  GH_TOKEN: string;
  LINEAR_API_KEY: string;
  GIT_AUTHOR_NAME: string;
  GIT_AUTHOR_EMAIL: string;
}

/**
 * Build the env vars object to pass into a container process.
 *
 * Reads all required secrets from the Worker `Env` and returns a plain object
 * suitable for the `env` option of `sandbox.startProcess()`.
 *
 * @example
 * ```ts
 * import { assertRequiredSecrets, getContainerEnv } from './secrets.js';
 *
 * assertRequiredSecrets(env);
 * const containerEnv = getContainerEnv(env);
 * await sandbox.startProcess('bash entrypoint.sh', { env: containerEnv });
 * ```
 */
export function getContainerEnv(env: Env): ContainerEnv {
  return {
    ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
    GH_TOKEN: env.GH_TOKEN,
    LINEAR_API_KEY: env.LINEAR_API_KEY,
    GIT_AUTHOR_NAME: env.GIT_AUTHOR_NAME,
    GIT_AUTHOR_EMAIL: env.GIT_AUTHOR_EMAIL
  };
}

/**
 * Required secret keys — must all be non-empty strings in `env`.
 * Typed against `ContainerEnv` to ensure this list stays in sync.
 */
const REQUIRED_SECRETS = [
  'ANTHROPIC_API_KEY',
  'GH_TOKEN',
  'LINEAR_API_KEY',
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL'
] as const satisfies readonly (keyof ContainerEnv)[];

/**
 * Assert that all required secrets are present and non-empty in the Worker env.
 *
 * Call this at the top of your request handler so a missing secret produces
 * a clear error at startup rather than a silent failure deep in container
 * execution.
 *
 * @throws {Error} with a descriptive message listing all missing secrets.
 *
 * @example
 * ```ts
 * export default {
 *   async fetch(request: Request, env: Env): Promise<Response> {
 *     assertRequiredSecrets(env);
 *     // safe to use env.ANTHROPIC_API_KEY, env.GH_TOKEN, etc.
 *   }
 * };
 * ```
 */
export function assertRequiredSecrets(env: Env): void {
  const missing: string[] = [];

  for (const key of REQUIRED_SECRETS) {
    if (!env[key]) {
      missing.push(key);
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `Missing required secrets: ${missing.join(', ')}. ` +
        `For local dev, copy .dev.vars.example to .dev.vars and fill in values. ` +
        `For production, run: wrangler secret put <NAME>`
    );
  }
}
