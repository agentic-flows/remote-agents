/**
 * POST /api/dispatch — dispatch an lb issue to a remote agent.
 */
import { getSandbox } from '@cloudflare/sandbox';
import type { Config } from '@opencode-ai/sdk';
import { WORK_DIR, DEFAULT_MODEL, AGENT_PROFILES, getClient } from '../config.js';
import { setupWorkspace } from '../workspace.js';
import { Sandbox } from '../sandbox.js';

export async function handleDispatch(
  sandbox: ReturnType<typeof getSandbox>,
  env: Env,
  request: Request,
): Promise<Response> {
  try {
    const body = (await request.json()) as {
      issueId?: string;
      repo?: string;
      model?: { providerID: string; modelID: string };
      mcp?: Config['mcp'];
      system?: string;
      profile?: string;
    };
    if (!body.issueId) {
      return Response.json({ error: 'Missing "issueId" in request body' }, { status: 400 });
    }
    if (!body.repo) {
      return Response.json({ error: 'Missing "repo" in request body (e.g. "https://github.com/org/repo.git")' }, { status: 400 });
    }
    if (!env.LINEAR_API_KEY) {
      return Response.json(
        { error: 'LINEAR_API_KEY not configured — lb cannot sync with Linear' },
        { status: 500 },
      );
    }

    // Resolve profile (if specified) — profile provides defaults for model, system, mcp
    const profile = body.profile ? AGENT_PROFILES[body.profile] : undefined;
    if (body.profile && !profile) {
      return Response.json(
        { error: `Unknown profile "${body.profile}". Available: ${Object.keys(AGENT_PROFILES).join(', ')}` },
        { status: 400 },
      );
    }

    const issueId = body.issueId.toUpperCase();
    const branch = `${issueId}-remote`;

    // Set up workspace with lb
    await setupWorkspace(sandbox, env, {
      repo: body.repo,
      branch,
      setupLb: true,
    });

    // Read the issue description via lb
    const issueResult = await sandbox.exec(
      `cd ${WORK_DIR} && LINEAR_API_KEY=${env.LINEAR_API_KEY} lb show ${issueId} 2>&1`,
    );
    const issueDescription = issueResult.stdout || '';
    if (!issueDescription || issueDescription.includes('not found')) {
      return Response.json(
        { error: `Issue ${issueId} not found. Run lb sync first?`, raw: issueDescription },
        { status: 404 },
      );
    }

    // Claim the issue
    await sandbox.exec(
      `cd ${WORK_DIR} && LINEAR_API_KEY=${env.LINEAR_API_KEY} lb update ${issueId} --status in_progress 2>&1 || true`,
    );

    // Merge MCP: profile MCP (defaults) + body MCP (overrides)
    const mergedMcp = { ...profile?.mcp, ...body.mcp };

    // Start opencode serve + get SDK client (with MCP servers)
    const { client } = await getClient(sandbox, env, mergedMcp);

    // Create session
    const session = await client.session.create({
      title: `${issueId} — Remote Agent`,
      directory: WORK_DIR,
    });
    if (!session.data) {
      throw new Error(`Failed to create session: ${JSON.stringify(session)}`);
    }

    // Build the agent prompt
    const prompt = buildDispatchPrompt(issueId, branch, issueDescription, env);

    // Resolve model: explicit > profile > default
    const model = body.model || profile?.model || DEFAULT_MODEL;

    // Resolve system prompt: explicit > profile > none
    const systemPrompt = body.system || profile?.system;
    const fullPrompt = systemPrompt
      ? `${systemPrompt}\n\n---\n\n${prompt}`
      : prompt;

    // Fire prompt async
    await client.session.promptAsync({
      sessionID: session.data.id,
      directory: WORK_DIR,
      model,
      parts: [{ type: 'text', text: fullPrompt }],
    });

    // Persist session log to DO SQLite (survives container hibernation)
    await (sandbox as Sandbox).logSession({
      sessionId: session.data.id,
      issueId,
      prompt: fullPrompt,
      model,
      repo: body.repo,
      branch,
      workspaceKey: `issue/${issueId}`,
    });

    return Response.json({
      sessionId: session.data.id,
      issueId,
      branch,
      status: 'dispatched',
      model,
      profile: body.profile ?? null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return Response.json({ error: message }, { status: 500 });
  }
}

/**
 * Build the prompt sent to the remote agent for an lb issue.
 * This is self-contained — the agent has no prior context.
 */
function buildDispatchPrompt(
  issueId: string,
  branch: string,
  issueDescription: string,
  _env: Env,
): string {
  return `You are a remote coding agent working on issue ${issueId}.
You are on branch \`${branch}\` in /home/user/workspace.

## Your Issue

${issueDescription}

## Instructions

1. Read the issue carefully. Implement what is described.
2. Make your changes in the workspace. Write clean, well-structured code.
3. Test your changes if there are tests available (check package.json scripts).
4. When you are done coding:
   a. Stage and commit your changes with a descriptive commit message referencing ${issueId}.
   b. Push the branch: \`git push -u origin ${branch}\`
   c. Create a PR: \`gh pr create --title "${issueId}: <short summary>" --body "<description of changes>" --base main\`
   d. Update the issue status: \`LINEAR_API_KEY=$LINEAR_API_KEY lb update ${issueId} --status in_review\`
5. If you discover bugs or issues while working, create them immediately:
   \`LINEAR_API_KEY=$LINEAR_API_KEY lb create "Found: <description>" --discovered-from ${issueId} -d "Details..."\`

## Environment

- Git is configured with author identity.
- GitHub CLI (\`gh\`) is authenticated — you can push and create PRs.
- \`lb\` is available for issue tracking. LINEAR_API_KEY is set in the environment.
- You are on branch \`${branch}\`, based off \`main\`.

## Important

- Do NOT ask for clarification. Work with what you have.
- Do NOT skip steps. Commit, push, create PR, and update the issue status.
- Be thorough. The issue description contains your acceptance criteria.
`;
}
