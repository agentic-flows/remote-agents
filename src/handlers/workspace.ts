/**
 * Workspace API handlers: save, list, delete, read file.
 */
import { getSandbox } from '@cloudflare/sandbox';
import { WORK_DIR } from '../config.js';
import { saveWorkspace, resolveWorkspaceKey } from '../workspace.js';

/**
 * POST /api/workspace/save — save workspace to R2.
 * Body: { "workspace"?: "name", "sessionId"?: "...", "issueId"?: "..." }
 */
export async function handleWorkspaceSave(
  sandbox: ReturnType<typeof getSandbox>,
  env: Env,
  request: Request,
): Promise<Response> {
  try {
    const body = (await request.json()) as {
      workspace?: string;
      sessionId?: string;
      issueId?: string;
    };

    const key = resolveWorkspaceKey(body);
    const result = await saveWorkspace(sandbox, env, key);

    return Response.json({
      saved: true,
      key: result.key,
      size: result.size,
      sizeHuman: `${(result.size / 1024 / 1024).toFixed(2)} MB`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return Response.json({ error: `Failed to save workspace: ${message}` }, { status: 500 });
  }
}

/**
 * GET /api/workspace/list — list saved workspaces in R2.
 */
export async function handleWorkspaceList(env: Env): Promise<Response> {
  try {
    const list = await env.R2_BUCKET.list({ prefix: 'workspaces/' });
    const workspaces = list.objects.map((obj: any) => ({
      key: obj.key,
      name: obj.key.replace('workspaces/', '').replace('.tar.gz', ''),
      size: obj.size,
      sizeHuman: `${(obj.size / 1024 / 1024).toFixed(2)} MB`,
      uploaded: obj.uploaded.toISOString(),
    }));

    return Response.json({ workspaces });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return Response.json({ error: message }, { status: 500 });
  }
}

/**
 * DELETE /api/workspace/:name — delete a named workspace from R2.
 */
export async function handleWorkspaceDelete(env: Env, name: string): Promise<Response> {
  try {
    const key = `workspaces/named/${name}.tar.gz`;
    await env.R2_BUCKET.delete(key);
    return Response.json({ deleted: true, key });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return Response.json({ error: message }, { status: 500 });
  }
}

/**
 * GET /api/workspace/file/* — read a file from the live container workspace.
 * Returns the file content as text. For binary files, use /api/exec.
 */
export async function handleWorkspaceFile(
  sandbox: ReturnType<typeof getSandbox>,
  filePath: string,
): Promise<Response> {
  try {
    if (!filePath || filePath.includes('..')) {
      return Response.json({ error: 'Invalid file path' }, { status: 400 });
    }

    const fullPath = `${WORK_DIR}/${filePath}`;

    // Check if path is a directory
    const checkResult = await sandbox.exec(`test -d "${fullPath}" && echo DIR || test -f "${fullPath}" && echo FILE || echo NOTFOUND`);
    const type = checkResult.stdout?.trim();

    if (type === 'NOTFOUND') {
      return Response.json({ error: `File not found: ${filePath}` }, { status: 404 });
    }

    if (type === 'DIR') {
      // List directory contents
      const lsResult = await sandbox.exec(`ls -la "${fullPath}"`);
      return Response.json({
        type: 'directory',
        path: filePath,
        listing: lsResult.stdout,
      });
    }

    // Read file content
    const result = await sandbox.readFile(fullPath);
    return new Response(result.content, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'X-File-Path': filePath,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return Response.json({ error: message }, { status: 500 });
  }
}
