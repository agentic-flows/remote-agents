/**
 * POST /api/kickoff — raw prompt (no lb integration).
 */
import { getSandbox } from '@cloudflare/sandbox';
import type { Config } from '@opencode-ai/sdk';
import { WORK_DIR, DEFAULT_MODEL, AGENT_PROFILES, getClient } from '../config.js';
import { setupWorkspace } from '../workspace.js';
import { Sandbox } from '../sandbox.js';

export async function handleKickoff(
  sandbox: ReturnType<typeof getSandbox>,
  env: Env,
  request: Request,
): Promise<Response> {
  try {
    const body = (await request.json()) as {
      text?: string;
      repo?: string;
      project?: string;
      branch?: string;
      model?: { providerID: string; modelID: string };
      mcp?: Config['mcp'];
      system?: string;
      profile?: string;
      workspace?: string; // named workspace — persists across sessions via R2
    };
    if (!body.text) {
      return Response.json({ error: 'Missing "text" in request body' }, { status: 400 });
    }

    // Resolve profile
    const profile = body.profile ? AGENT_PROFILES[body.profile] : undefined;
    if (body.profile && !profile) {
      return Response.json(
        { error: `Unknown profile "${body.profile}". Available: ${Object.keys(AGENT_PROFILES).join(', ')}` },
        { status: 400 },
      );
    }

    const repoUrl = await setupWorkspace(sandbox, env, {
      repo: body.repo,
      branch: body.branch,
      workspace: body.workspace,
      setupLb: false,
    });

    // Merge MCP: profile MCP (defaults) + body MCP (overrides)
    const mergedMcp = { ...profile?.mcp, ...body.mcp };

    const { client } = await getClient(sandbox, env, mergedMcp);

    const session = await client.session.create({
      title: body.workspace
        ? `Workspace: ${body.workspace}`
        : body.project
          ? `Project: ${body.project}`
          : 'Remote Agent',
      directory: WORK_DIR,
    });
    if (!session.data) {
      throw new Error(`Failed to create session: ${JSON.stringify(session)}`);
    }

    // Build the prompt with persistence instructions and system prompt
    let promptText = body.text;
    if (repoUrl) {
      promptText += `\n\n## Persistence\n\nYour workspace is backed by a GitHub repo: ${repoUrl}\nWhen you are done, commit all your work and push it so nothing is lost.\nUse: \`git add -A && git commit -m "description" && git push\`\nIf pushing fails with auth errors, use: \`git push https://\${GH_TOKEN}@github.com/... HEAD:refs/heads/main\``;
    } else if (body.workspace) {
      promptText += `\n\n## Persistence\n\nYour workspace is a named R2 workspace: "${body.workspace}"\nYour work will be automatically saved when the session completes.\nYou do not need to push to git unless you want to — files persist in R2.`;
    }

    // Resolve system prompt: explicit > profile > none
    const systemPrompt = body.system || profile?.system;
    const fullPrompt = systemPrompt
      ? `${systemPrompt}\n\n---\n\n${promptText}`
      : promptText;

    // Resolve model: explicit > profile > default
    const model = body.model || profile?.model || DEFAULT_MODEL;

    await client.session.promptAsync({
      sessionID: session.data.id,
      directory: WORK_DIR,
      model,
      parts: [{ type: 'text', text: fullPrompt }],
    });

    // Resolve the workspace key for later save operations
    const workspaceKey = body.workspace
      ? `named/${body.workspace}`
      : undefined;

    // Persist session log to DO SQLite (survives container hibernation)
    await (sandbox as Sandbox).logSession({
      sessionId: session.data.id,
      prompt: fullPrompt,
      model,
      repo: repoUrl ?? undefined,
      workspaceKey,
    });

    return Response.json({
      sessionId: session.data.id,
      status: 'kicked off',
      model,
      repo: repoUrl,
      profile: body.profile ?? null,
      workspace: body.workspace ?? null,
      workspaceKey: workspaceKey ?? null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return Response.json({ error: message }, { status: 500 });
  }
}
