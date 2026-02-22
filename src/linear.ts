/**
 * Direct Linear GraphQL API client.
 * No container dependency — calls Linear API directly from the Worker.
 */

const LINEAR_API = 'https://api.linear.app/graphql';

async function gql(apiKey: string, query: string, variables?: Record<string, unknown>) {
  const res = await fetch(LINEAR_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: apiKey,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`Linear API error: ${res.status} ${await res.text()}`);
  const json = await res.json() as { data?: unknown; errors?: { message: string }[] };
  if (json.errors?.length) throw new Error(json.errors.map(e => e.message).join(', '));
  return json.data;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description?: string;
  state: { name: string; type: string };
  priority: number;
  assignee?: { name: string };
  parent?: { identifier: string; title: string };
  relations?: { nodes: { type: string; relatedIssue: { identifier: string; title: string } }[] };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** List issues filtered by state type and/or name */
export async function listIssues(apiKey: string, opts: {
  teamKey?: string;
  stateTypes?: string[];   // e.g. ['unstarted', 'started']
  stateNames?: string[];   // e.g. ['todo_refined', 'in_progress']
  label?: string;
  limit?: number;
}): Promise<LinearIssue[]> {
  const filter: Record<string, unknown> = {};
  if (opts.teamKey) filter.team = { key: { eq: opts.teamKey } };
  if (opts.stateTypes?.length) filter.state = { type: { in: opts.stateTypes } };
  if (opts.stateNames?.length) filter.state = { ...(filter.state as object || {}), name: { in: opts.stateNames } };
  if (opts.label) filter.labels = { some: { name: { eq: opts.label } } };

  const data = await gql(apiKey, `
    query ListIssues($filter: IssueFilter, $first: Int) {
      issues(filter: $filter, first: $first, orderBy: priority) {
        nodes {
          id identifier title description
          state { name type }
          priority
          assignee { name }
          parent { identifier title }
        }
      }
    }
  `, { filter, first: opts.limit ?? 50 }) as { issues: { nodes: LinearIssue[] } };

  return data.issues.nodes;
}

/** Get a single issue by identifier (e.g. "AGE-42") */
export async function getIssue(apiKey: string, identifier: string): Promise<LinearIssue> {
  const data = await gql(apiKey, `
    query GetIssue($identifier: String!) {
      issue(id: $identifier) {
        id identifier title description
        state { name type }
        priority
        assignee { name }
        parent { identifier title }
        relations {
          nodes {
            type
            relatedIssue { identifier title }
          }
        }
      }
    }
  `, { identifier }) as { issue: LinearIssue };

  if (!data.issue) throw new Error(`Issue ${identifier} not found`);
  return data.issue;
}

/** Update issue state by name */
export async function updateIssueState(apiKey: string, issueId: string, stateName: string): Promise<void> {
  // First resolve the state ID from name
  const stateData = await gql(apiKey, `
    query GetState($name: String!) {
      workflowStates(filter: { name: { eq: $name } }) {
        nodes { id name }
      }
    }
  `, { name: stateName }) as { workflowStates: { nodes: { id: string; name: string }[] } };

  const state = stateData.workflowStates.nodes[0];
  if (!state) throw new Error(`State "${stateName}" not found in Linear`);

  await gql(apiKey, `
    mutation UpdateIssue($id: String!, $stateId: String!) {
      issueUpdate(id: $id, input: { stateId: $stateId }) {
        success
      }
    }
  `, { id: issueId, stateId: state.id });
}

/** Create a new issue */
export async function createIssue(apiKey: string, opts: {
  teamKey: string;
  title: string;
  description?: string;
  stateName?: string;
  parentId?: string;
}): Promise<{ identifier: string; id: string }> {
  // Resolve team ID
  const teamData = await gql(apiKey, `
    query GetTeam($key: String!) {
      teams(filter: { key: { eq: $key } }) {
        nodes { id key }
      }
    }
  `, { key: opts.teamKey }) as { teams: { nodes: { id: string }[] } };

  const team = teamData.teams.nodes[0];
  if (!team) throw new Error(`Team "${opts.teamKey}" not found`);

  const input: Record<string, unknown> = {
    teamId: team.id,
    title: opts.title,
    description: opts.description,
  };
  if (opts.parentId) input.parentId = opts.parentId;

  const data = await gql(apiKey, `
    mutation CreateIssue($input: IssueCreateInput!) {
      issueCreate(input: $input) {
        success
        issue { id identifier }
      }
    }
  `, { input }) as { issueCreate: { issue: { id: string; identifier: string } } };

  return data.issueCreate.issue;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

export function formatIssueList(issues: LinearIssue[]): string {
  if (!issues.length) return 'No issues found.';
  return issues.map(i =>
    `${i.identifier} [${i.state.name}] ${i.title}${i.assignee ? ` (@${i.assignee.name})` : ''}`
  ).join('\n');
}

export function formatIssueDetail(issue: LinearIssue): string {
  const lines = [
    `${issue.identifier}: ${issue.title}`,
    `Status: ${issue.state.name}`,
    issue.assignee ? `Assignee: ${issue.assignee.name}` : null,
    issue.parent ? `Parent: ${issue.parent.identifier} — ${issue.parent.title}` : null,
    issue.description ? `\n${issue.description}` : null,
  ].filter(Boolean);

  if (issue.relations?.nodes.length) {
    lines.push('');
    for (const r of issue.relations.nodes) {
      lines.push(`${r.type}: ${r.relatedIssue.identifier} — ${r.relatedIssue.title}`);
    }
  }

  return lines.join('\n');
}
