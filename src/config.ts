/**
 * Configuration: constants, models, agent profiles, MCP servers, SDK client.
 */
import { getSandbox } from '@cloudflare/sandbox';
import { createOpencode, createOpencodeServer } from '@cloudflare/sandbox/opencode';
import type { Config } from '@opencode-ai/sdk';

export const WORK_DIR = '/home/user/workspace';

// Free models available via opencode's built-in provider:
//   opencode/big-pickle       — Anthropic-based, 200k ctx, reasoning + tools
//   opencode/glm-5-free       — GLM-5, 200k ctx, reasoning + tools
//   opencode/gpt-5-nano       — GPT-5 Nano, 400k ctx, reasoning + tools
//   opencode/minimax-m2.5-free — MiniMax, tools
//   opencode/trinity-large-preview-free — Trinity, tools
export const DEFAULT_MODEL = {
  providerID: 'opencode',
  modelID: 'big-pickle',
};

// The sandbox SDK uses @opencode-ai/sdk v2 client at runtime (flat params),
// but TypeScript resolves the v1 types from the package root. We use `any`
// for the client to avoid type mismatches.
export type SdkClient = any;

// ---------------------------------------------------------------------------
// Agent Profiles — named bundles of model + system prompt + MCP servers.
// Select via `"profile": "researcher"` in dispatch/kickoff request body.
// Profile settings are defaults that can be overridden by explicit params.
// ---------------------------------------------------------------------------
export interface AgentProfile {
  model: { providerID: string; modelID: string };
  system?: string;
  mcp?: Config['mcp'];
}

export const AGENT_PROFILES: Record<string, AgentProfile> = {
  // Default coder — no special system prompt, relies on AGENTS.md from repo
  coder: {
    model: { providerID: 'opencode', modelID: 'big-pickle' },
  },

  // Research agent — optimized for web research, summarization, and analysis
  researcher: {
    model: { providerID: 'opencode', modelID: 'big-pickle' },
    system: `You are a research agent. Your primary job is to gather information, analyze it, and produce well-structured research reports.

## Tools & Approach

- Use web search and fetch tools aggressively to gather information from multiple sources.
- Cross-reference claims across sources. Note disagreements or uncertainty.
- Cite your sources with URLs.
- Structure your output with clear sections, headings, and bullet points.
- When writing files, use markdown format with proper frontmatter.

## Output

Always save your research to files in the workspace:
- Main report: \`research.md\` or \`<topic>.md\`
- Raw notes: \`notes/\` directory for supporting material
- Data: \`data/\` directory for any structured data (JSON, CSV)

When done, commit and push all files to preserve your work.`,
    mcp: {
      // Researcher gets all default MCP servers plus any extras
    },
  },

  // Refiner agent — reads issues and adds implementation details
  refiner: {
    model: { providerID: 'opencode', modelID: 'big-pickle' },
    system: `You are an issue refinement agent. Your job is to take rough issue descriptions and add detailed implementation plans.

## Process

1. Read the issue description carefully.
2. Explore the codebase to understand the architecture and patterns.
3. Add to the issue description:
   - Technical approach with specific files to modify
   - Step-by-step implementation plan
   - Acceptance criteria (testable, specific)
   - Dependencies and risks
   - Estimated complexity

## Style

- Be specific: name files, functions, line numbers.
- Be practical: focus on what to change, not theory.
- Be thorough: cover edge cases and error handling.
- Keep it concise: developers will read this while coding.`,
  },

  // Reviewer agent — reviews PRs and code
  reviewer: {
    model: { providerID: 'opencode', modelID: 'big-pickle' },
    system: `You are a code review agent. Your job is to review code changes and provide actionable feedback.

## Process

1. Read the PR diff or code changes.
2. Check for: bugs, security issues, performance problems, missing error handling, style inconsistencies.
3. Verify the implementation matches the issue requirements.
4. Check that tests cover the changes.

## Output

Provide feedback as:
- **Critical**: Must fix before merge (bugs, security, data loss)
- **Important**: Should fix (error handling, performance, maintainability)
- **Suggestion**: Nice to have (style, naming, documentation)

Be specific: reference file paths and line numbers. Suggest fixes, don't just point out problems.`,
  },
};

// MCP servers available to all remote agents by default.
// Additional servers can be added per-request via the `mcp` body param.
//
// Format reference (from opencode docs):
//   Local:  { type: "local", command: ["npx", "-y", "package"], environment: {} }
//   Remote: { type: "remote", url: "https://...", headers: {} }
export const getDefaultMcp = (_env: Env): Config['mcp'] => ({
  // Fetch: HTTP requests, web scraping — pre-installed in container, no API key
  fetch: {
    type: 'local',
    command: ['npx', '-y', '@modelcontextprotocol/server-fetch'],
    enabled: true,
  },
  // Context7: AI-powered documentation search — remote MCP, no API key
  context7: {
    type: 'remote',
    url: 'https://mcp.context7.com/mcp',
    enabled: true,
  },
  // ref-tools-docs: Documentation search with ref.tools
  'ref-tools-docs': {
    type: 'remote',
    url: 'https://api.ref.tools/mcp',
    enabled: true,
  },
});

export const getConfig = (env: Env, extraMcp?: Config['mcp']): Config => ({
  provider: {
    // The opencode provider hosts free models (big-pickle, gpt-5-nano, etc.)
    // It requires an API key obtained via `opencode auth login`.
    // The sandbox SDK extracts this and sets OPENCODE_API_KEY env var
    // for the opencode server process (see @cloudflare/sandbox/opencode).
    opencode: {
      options: { apiKey: env.OPENCODE_API_KEY },
    },
  },
  mcp: {
    ...getDefaultMcp(env),
    ...extraMcp,
  },
});

/**
 * Get an opencode SDK client for the sandbox.
 * createOpencode starts `opencode serve` if not already running.
 */
export async function getClient(
  sandbox: ReturnType<typeof getSandbox>,
  env: Env,
  extraMcp?: Config['mcp'],
) {
  return createOpencode<SdkClient>(sandbox, {
    directory: WORK_DIR,
    config: getConfig(env, extraMcp),
  });
}

/**
 * Get an opencode server handle (for proxying the web UI).
 */
export async function getServer(
  sandbox: ReturnType<typeof getSandbox>,
  env: Env,
) {
  return createOpencodeServer(sandbox, {
    directory: WORK_DIR,
    config: getConfig(env),
  });
}
