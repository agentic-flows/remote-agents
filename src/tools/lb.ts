/**
 * AI SDK tools wrapping Linear/lb operations.
 *
 * These tools let the orchestrator LLM interact with Linear issues
 * (the same data that `lb` manages locally). They call the Linear
 * GraphQL API directly since the Worker has no shell.
 */
import { tool } from 'ai';
import { z } from 'zod';
import {
  getIssue,
  getReadyIssues,
  getBlockedIssues,
  listIssues,
  updateIssueStatus,
  createIssue,
} from '../linear.js';

const TEAM_KEY = 'AGE';

export function createLbTools(env: Env) {
  const apiKey = env.LINEAR_API_KEY;

  return {
    lb_ready: tool({
      description:
        'List issues ready to work on (status: Todo - Refined or Todo - Bug, and not blocked by open issues). Returns identifiers, titles, and priorities.',
      inputSchema: z.object({}),
      execute: async (): Promise<string> => {
        try {
          const issues = await getReadyIssues(apiKey, TEAM_KEY);
          if (issues.length === 0) return 'No ready issues.';
          return issues
            .map(
              (i) =>
                `[P${i.priority}] ${i.identifier}: ${i.title} (${i.state.name})`,
            )
            .join('\n');
        } catch (e) {
          return `Error: ${e instanceof Error ? e.message : String(e)}`;
        }
      },
    }),

    lb_show: tool({
      description:
        'Show full details of a specific issue including description, status, relations, and children. Use when you need to understand an issue before launching an agent or answering questions about it.',
      inputSchema: z.object({
        identifier: z.string().describe('Issue identifier, e.g. "AGE-172"'),
      }),
      execute: async ({ identifier }): Promise<string> => {
        try {
          const issue = await getIssue(apiKey, identifier);
          if (!issue) return `Issue ${identifier} not found.`;

          const lines = [
            `${issue.identifier}: ${issue.title}`,
            `  Status: ${issue.state.name}`,
            `  Priority: P${issue.priority}`,
          ];

          if (issue.parent) {
            lines.push(`  Parent: ${issue.parent.identifier} — ${issue.parent.title}`);
          }

          if (issue.children.nodes.length > 0) {
            lines.push('  Children:');
            for (const c of issue.children.nodes) {
              lines.push(`    ${c.identifier}: ${c.title} (${c.state.name})`);
            }
          }

          if (issue.relations.nodes.length > 0) {
            lines.push('  Relations:');
            for (const r of issue.relations.nodes) {
              lines.push(
                `    ${r.type} ${r.relatedIssue.identifier}: ${r.relatedIssue.title} (${r.relatedIssue.state.name})`,
              );
            }
          }

          if (issue.description) {
            lines.push('  Description:', issue.description);
          }

          return lines.join('\n');
        } catch (e) {
          return `Error: ${e instanceof Error ? e.message : String(e)}`;
        }
      },
    }),

    lb_blocked: tool({
      description:
        'Show issues that are blocked by other open issues. Useful for understanding the dependency graph.',
      inputSchema: z.object({}),
      execute: async (): Promise<string> => {
        try {
          const blocked = await getBlockedIssues(apiKey, TEAM_KEY);
          if (blocked.length === 0) return 'No blocked issues.';
          return blocked
            .map(
              (b) =>
                `[P${b.issue.priority}] ${b.issue.identifier}: ${b.issue.title}\n  Blocked by: ${b.blockedBy.map((bl) => bl.identifier).join(', ')}`,
            )
            .join('\n\n');
        } catch (e) {
          return `Error: ${e instanceof Error ? e.message : String(e)}`;
        }
      },
    }),

    lb_list: tool({
      description: 'List all issues for the team, optionally filtered by state name.',
      inputSchema: z.object({
        stateName: z
          .string()
          .optional()
          .describe(
            'Optional Linear state name filter, e.g. "In Progress", "Todo - Refined", "Done"',
          ),
      }),
      execute: async ({ stateName }): Promise<string> => {
        try {
          const stateNames = stateName ? [stateName] : undefined;
          const issues = await listIssues(apiKey, TEAM_KEY, { stateNames });
          if (issues.length === 0) return 'No matching issues.';
          return issues
            .map(
              (i) =>
                `[P${i.priority}] ${i.identifier}: ${i.title} (${i.state.name})`,
            )
            .join('\n');
        } catch (e) {
          return `Error: ${e instanceof Error ? e.message : String(e)}`;
        }
      },
    }),

    lb_update: tool({
      description:
        'Update an issue status. Valid statuses: todo_needs_refinement, todo_refined, todo_bug, in_progress, in_review, done.',
      inputSchema: z.object({
        identifier: z.string().describe('Issue identifier, e.g. "AGE-172"'),
        status: z
          .enum([
            'todo_needs_refinement',
            'todo_refined',
            'todo_bug',
            'in_progress',
            'in_review',
            'done',
          ])
          .describe('New status for the issue'),
      }),
      execute: async ({ identifier, status }): Promise<string> => {
        try {
          const result = await updateIssueStatus(apiKey, identifier, status);
          return `Updated ${identifier} to "${result.newState}".`;
        } catch (e) {
          return `Error: ${e instanceof Error ? e.message : String(e)}`;
        }
      },
    }),

    lb_create: tool({
      description:
        'Create a new issue in Linear. Defaults to "Todo - Needs Refinement" status.',
      inputSchema: z.object({
        title: z.string().describe('Issue title'),
        description: z.string().optional().describe('Issue description (markdown)'),
        parentIdentifier: z
          .string()
          .optional()
          .describe('Parent issue identifier for subtasks, e.g. "AGE-170"'),
      }),
      execute: async ({ title, description, parentIdentifier }): Promise<string> => {
        try {
          const issue = await createIssue(apiKey, TEAM_KEY, title, {
            description,
            parentIdentifier,
          });
          return `Created ${issue.identifier}: ${issue.title}`;
        } catch (e) {
          return `Error: ${e instanceof Error ? e.message : String(e)}`;
        }
      },
    }),
  };
}
