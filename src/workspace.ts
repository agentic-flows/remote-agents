/**
 * Workspace management: setup, R2 save/restore, key resolution.
 */
import { getSandbox } from '@cloudflare/sandbox';
import { WORK_DIR } from './config.js';

// Excludes for tar archives: keep snapshots small
const WORKSPACE_EXCLUDES = [
  '--exclude=node_modules',
  '--exclude=.git',
  '--exclude=__pycache__',
  '--exclude=.next',
  '--exclude=dist',
  '--exclude=.opencode',
].join(' ');

// ---------------------------------------------------------------------------
// Setup workspace in the container (clone, git, gh, secrets, lb)
// ---------------------------------------------------------------------------

/**
 * Set up the container workspace.
 * Returns the repo URL that was set up (existing or newly created), or null.
 */
export async function setupWorkspace(
  sandbox: ReturnType<typeof getSandbox>,
  env: Env,
  opts: {
    repo?: string;
    project?: string;
    branch?: string;
    setupLb?: boolean;
    workspace?: string; // named workspace to restore from R2
  },
): Promise<string | null> {
  // Clean workspace
  await sandbox.exec(`cd /tmp && rm -rf ${WORK_DIR}`);

  let repoUrl: string | null = null;

  if (opts.repo) {
    // Clone existing repo
    await sandbox.gitCheckout(opts.repo, { targetDir: WORK_DIR });
    repoUrl = opts.repo;
  } else if (opts.project && env.GH_TOKEN) {
    // Check if repo already exists, if so clone it; otherwise create it
    const check = await sandbox.exec(
      `gh repo view agentic-flows/${opts.project} --json url 2>&1`,
    );
    if (check.stdout?.includes('url')) {
      // Repo exists — clone it
      const parsed = JSON.parse(check.stdout);
      repoUrl = parsed.url + '.git';
      await sandbox.gitCheckout(repoUrl, { targetDir: WORK_DIR });
    } else {
      // Create new repo with an initial commit so --push works
      await sandbox.exec(`mkdir -p ${WORK_DIR}`);
      await sandbox.exec(`cd ${WORK_DIR} && git init -b main`);
      await sandbox.exec(
        `cd ${WORK_DIR} && echo "# ${opts.project}" > README.md && git add README.md && git commit -m "init"`,
      );
      await sandbox.exec(
        `cd ${WORK_DIR} && gh repo create agentic-flows/${opts.project} --private --source=. --push 2>&1`,
      );
      repoUrl = `https://github.com/agentic-flows/${opts.project}.git`;
    }
  } else if (opts.workspace) {
    // Named workspace — try to restore from R2 first
    let restored = false;
    try {
      restored = await restoreWorkspace(sandbox, env, `named/${opts.workspace}`);
    } catch (e) {
      // Log but don't fail — fall through to fresh workspace
      console.error('Workspace restore failed:', e);
    }
    if (!restored) {
      // No existing snapshot or restore failed — create fresh workspace
      await sandbox.exec(`mkdir -p ${WORK_DIR}`);
      await sandbox.exec(`cd ${WORK_DIR} && git init -b main`);
    }
  } else {
    // Bare workspace — no git remote
    await sandbox.exec(`mkdir -p ${WORK_DIR}`);
    await sandbox.exec(`cd ${WORK_DIR} && git init -b main`);
  }

  // Git identity
  if (env.GIT_AUTHOR_NAME) {
    await sandbox.exec(`git config --global user.name "${env.GIT_AUTHOR_NAME}"`);
  }
  if (env.GIT_AUTHOR_EMAIL) {
    await sandbox.exec(`git config --global user.email "${env.GIT_AUTHOR_EMAIL}"`);
  }
  await sandbox.exec(`git config --global --add safe.directory ${WORK_DIR}`);

  // GitHub CLI auth + git credential helper (so git push works via gh)
  if (env.GH_TOKEN) {
    await sandbox.exec(`echo "${env.GH_TOKEN}" | gh auth login --with-token`);
    await sandbox.exec(`git config --global credential.helper "!gh auth git-credential"`);
  }

  // Inject secrets into container environment (persists for all subsequent exec calls)
  // Write them to /etc/environment so all processes (including opencode's bash tool) see them
  const envLines: string[] = [];
  if (env.LINEAR_API_KEY) envLines.push(`LINEAR_API_KEY=${env.LINEAR_API_KEY}`);
  if (env.GH_TOKEN) envLines.push(`GH_TOKEN=${env.GH_TOKEN}`);
  if (env.ANTHROPIC_API_KEY) envLines.push(`ANTHROPIC_API_KEY=${env.ANTHROPIC_API_KEY}`);
  if (env.GIT_AUTHOR_NAME) envLines.push(`GIT_AUTHOR_NAME=${env.GIT_AUTHOR_NAME}`);
  if (env.GIT_AUTHOR_EMAIL) envLines.push(`GIT_AUTHOR_EMAIL=${env.GIT_AUTHOR_EMAIL}`);
  if (envLines.length > 0) {
    // Write to profile so interactive and non-interactive shells pick them up
    const exports = envLines.map((l) => `export ${l}`).join('\n');
    await sandbox.exec(`echo '${exports}' >> /root/.bashrc`);
    // Also set them in the current shell context for immediate use
    await sandbox.exec(exports);
  }

  // Checkout branch if specified
  if (opts.branch) {
    const check = await sandbox.exec(
      `cd ${WORK_DIR} && git ls-remote --exit-code --heads origin "${opts.branch}" 2>/dev/null && echo EXISTS || echo NEW`,
    );
    if (check.stdout?.includes('EXISTS')) {
      await sandbox.exec(
        `cd ${WORK_DIR} && git checkout -b "${opts.branch}" "origin/${opts.branch}"`,
      );
    } else {
      await sandbox.exec(`cd ${WORK_DIR} && git checkout -b "${opts.branch}"`);
    }
  }

  // Set up lb if requested
  if (opts.setupLb && env.LINEAR_API_KEY) {
    await sandbox.exec(
      `cd ${WORK_DIR} && LINEAR_API_KEY=${env.LINEAR_API_KEY} lb onboard 2>&1 || true`,
    );
    await sandbox.exec(
      `cd ${WORK_DIR} && LINEAR_API_KEY=${env.LINEAR_API_KEY} lb sync 2>&1 || true`,
    );
  }

  return repoUrl;
}

// ---------------------------------------------------------------------------
// R2 Workspace Persistence
// ---------------------------------------------------------------------------

/**
 * Save the current workspace to R2 as a compressed tar archive.
 *
 * Strategy: tar + gzip + base64-encode inside the container, then read the
 * base64 text via exec (ASCII-safe, avoids readFileStream's structured
 * envelope format). Decode from base64 in the Worker before uploading to R2.
 */
export async function saveWorkspace(
  sandbox: ReturnType<typeof getSandbox>,
  env: Env,
  key: string,
): Promise<{ key: string; size: number }> {
  const r2Key = `workspaces/${key}.tar.gz`;
  const archivePath = '/tmp/workspace-snapshot.tar.gz';
  const b64Path = '/tmp/workspace-snapshot.b64';

  // Create compressed archive (excluding heavy dirs)
  await sandbox.exec(
    `cd /home/user && tar czf ${archivePath} ${WORKSPACE_EXCLUDES} workspace/ 2>&1`,
  );

  // Base64-encode inside the container so we can read it as ASCII text
  await sandbox.exec(`base64 ${archivePath} > ${b64Path}`);

  // Read the base64 text (ASCII-safe) via exec in chunks
  // First get the size to know how many chunks we need
  const sizeResult = await sandbox.exec(`wc -c < ${b64Path}`);
  const b64Size = parseInt(sizeResult.stdout?.trim() || '0', 10);

  if (b64Size === 0) {
    throw new Error('Failed to create workspace archive');
  }

  // Read base64 in chunks via exec (each exec has output limits)
  // Use dd for precise byte-range reads
  const CHUNK_SIZE = 200000; // ~200KB per read, well within exec limits
  let b64String = '';
  for (let offset = 0; offset < b64Size; offset += CHUNK_SIZE) {
    const count = Math.min(CHUNK_SIZE, b64Size - offset);
    const result = await sandbox.exec(
      `dd if=${b64Path} bs=1 skip=${offset} count=${count} 2>/dev/null`,
    );
    b64String += result.stdout || '';
  }

  // Strip whitespace (base64 command adds line breaks)
  b64String = b64String.replace(/\s/g, '');

  // Decode from base64 to binary
  const binaryString = atob(b64String);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }

  await env.R2_BUCKET.put(r2Key, bytes.buffer);

  // Clean up temp files
  await sandbox.exec(`rm -f ${archivePath} ${b64Path}`);

  return { key: r2Key, size: bytes.length };
}

/**
 * Restore a workspace from R2 into the container.
 *
 * The sandbox writeFile API uses UTF-8 encoding which corrupts binary data.
 * Instead, we convert to base64 (ASCII-safe) and write it via shell commands,
 * then decode inside the container.
 *
 * Returns true if a snapshot was found and restored.
 */
export async function restoreWorkspace(
  sandbox: ReturnType<typeof getSandbox>,
  env: Env,
  key: string,
): Promise<boolean> {
  const r2Key = `workspaces/${key}.tar.gz`;

  // Check if snapshot exists in R2
  const obj = await env.R2_BUCKET.get(r2Key);
  if (!obj) return false;

  // Convert binary → base64 (ASCII-safe for shell transport)
  const data = await obj.arrayBuffer();
  const bytes = new Uint8Array(data);

  // Encode to base64 manually using a lookup table
  const base64Chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let base64 = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    base64 += base64Chars[a >> 2];
    base64 += base64Chars[((a & 3) << 4) | (b >> 4)];
    base64 += i + 1 < bytes.length ? base64Chars[((b & 15) << 2) | (c >> 6)] : '=';
    base64 += i + 2 < bytes.length ? base64Chars[c & 63] : '=';
  }

  // Write base64 string to container in chunks via shell
  // Base64 is pure ASCII (A-Za-z0-9+/=) so shell-safe in single quotes
  const b64File = '/tmp/_ws_restore.b64';
  const tarFile = '/tmp/_ws_restore.tar.gz';
  await sandbox.exec(`rm -f ${b64File} ${tarFile}`);

  const CHUNK_SIZE = 50000; // well under ARG_MAX
  for (let i = 0; i < base64.length; i += CHUNK_SIZE) {
    const chunk = base64.slice(i, i + CHUNK_SIZE);
    await sandbox.exec(`printf '%s' '${chunk}' >> ${b64File}`);
  }

  // Decode and extract
  const decodeResult = await sandbox.exec(
    `base64 -d ${b64File} > ${tarFile} 2>&1 && echo DECODE_OK || echo DECODE_FAIL`,
  );
  if (!decodeResult.stdout?.includes('DECODE_OK')) {
    console.error('restoreWorkspace: base64 decode failed:', decodeResult.stdout, decodeResult.stderr);
    await sandbox.exec(`rm -f ${b64File} ${tarFile}`);
    return false;
  }

  const extractResult = await sandbox.exec(
    `cd /home/user && tar xzf ${tarFile} 2>&1 && echo EXTRACT_OK || echo EXTRACT_FAIL`,
  );
  if (!extractResult.stdout?.includes('EXTRACT_OK')) {
    console.error('restoreWorkspace: tar extract failed:', extractResult.stdout, extractResult.stderr);
    await sandbox.exec(`rm -f ${b64File} ${tarFile}`);
    return false;
  }

  // Clean up
  await sandbox.exec(`rm -f ${b64File} ${tarFile}`);

  return true;
}

/**
 * Resolve the R2 workspace key from request params.
 * Priority: explicit workspace name > issueId > sessionId
 */
export function resolveWorkspaceKey(opts: {
  workspace?: string;
  issueId?: string;
  sessionId?: string;
}): string {
  if (opts.workspace) return `named/${opts.workspace}`;
  if (opts.issueId) return `issue/${opts.issueId}`;
  if (opts.sessionId) return `session/${opts.sessionId}`;
  return `session/${crypto.randomUUID()}`;
}
