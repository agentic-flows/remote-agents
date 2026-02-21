/**
 * POST /api/exec — run command in container (debug).
 */
import { getSandbox } from '@cloudflare/sandbox';

export async function handleExec(
  sandbox: ReturnType<typeof getSandbox>,
  request: Request,
): Promise<Response> {
  try {
    const body = (await request.json()) as { command?: string };
    if (!body.command) {
      return Response.json({ error: 'Missing "command"' }, { status: 400 });
    }

    const result = await sandbox.exec(body.command);
    return Response.json({
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      exitCode: result.exitCode ?? 0,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return Response.json({ error: message }, { status: 500 });
  }
}
