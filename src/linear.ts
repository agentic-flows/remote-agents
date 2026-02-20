/**
 * Linear API client for the orchestrator Worker.
 *
 * Replaces the `lb` CLI (which requires Bun/SQLite) with direct GraphQL
 * calls to the Linear API.  Only implements the queries the orchestrator
 * tools actually need — issue reads, status updates, and creation.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number;
  state: { name: string; type: string };
  parent: { identifier: string; title: string } | null;
  children: { nodes: { identifier: string; title: string; state: { name: string; type: string } }[] };
  relations: {
    nodes: {
      type: string;
      relatedIssue: { identifier: string; title: string; state: { name: string; type: string } };
    }[];
  };
  inverseRelations: {
    nodes: {
      type: string;
      issue: { identifier: string; title: string; state: { name: string; type: string } };
    }[];
  };
}

export interface LinearIssueCompact {
  identifier: string;
  title: string;
  priority: number;
  state: { name: string; type: string };
}

// Map lb status names to Linear workflow state names.
// These must match the ACTUAL state names in the Linear workspace.
const LB_TO_LINEAR_STATE: Record<string, string> = {
  todo_needs_refinement: 'Todo Needs Refinement',
  todo_refined: 'Todo Refined',
  todo_bug: 'Todo Bug',
  in_progress: 'In Progress',
  in_review: 'In Review',
  done: 'Done',
};

// ---------------------------------------------------------------------------
// GraphQL helpers
// ---------------------------------------------------------------------------

async function linearQuery(
  apiKey: string,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<unknown> {
  const res = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: apiKey,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Linear API error ${res.status}: ${text}`);
  }

  const json = (await res.json()) as { data?: unknown; errors?: { message: string }[] };
  if (json.errors?.length) {
    throw new Error(`Linear GraphQL error: ${json.errors.map((e) => e.message).join(', ')}`);
  }
  return json.data;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get a single issue by its identifier (e.g. "AGE-172").
 *
 * Uses the `issue(id:)` query which accepts both UUIDs and identifiers.
 */
export async function getIssue(apiKey: string, identifier: string): Promise<LinearIssue | null> {
  const data = (await linearQuery(apiKey, `
    query($id: String!) {
      issue(id: $id) {
        id
        identifier
        title
        description
        priority
        state { name type }
        parent { identifier title }
        children { nodes { identifier title state { name type } } }
        relations { nodes { type relatedIssue { identifier title state { name type } } } }
        inverseRelations { nodes { type issue { identifier title state { name type } } } }
      }
    }
  `, { id: identifier })) as { issue: LinearIssue | null };

  return data.issue;
}

/**
 * List issues for a team, optionally filtered by state names.
 *
 * Uses the root `issues` query with `filter: { team: { key: { eq: ... } } }`
 * instead of `team(id:)` which requires a UUID.
 */
export async function listIssues(
  apiKey: string,
  teamKey: string,
  options?: { stateNames?: string[]; first?: number },
): Promise<LinearIssueCompact[]> {
  // Build filter dynamically but safely via variables
  const variables: Record<string, unknown> = {
    teamKey,
    first: options?.first ?? 50,
  };

  // If state names are provided, include them as a variable
  let stateFilter = '';
  if (options?.stateNames?.length) {
    variables.stateNames = options.stateNames;
    stateFilter = ', state: { name: { in: $stateNames } }';
  }

  const data = (await linearQuery(apiKey, `
    query($teamKey: String!, $first: Int${options?.stateNames?.length ? ', $stateNames: [String!]!' : ''}) {
      issues(
        filter: { team: { key: { eq: $teamKey } }${stateFilter} }
        first: $first
      ) {
        nodes {
          identifier
          title
          priority
          state { name type }
        }
      }
    }
  `, variables)) as { issues: { nodes: LinearIssueCompact[] } };

  return data.issues.nodes;
}

/**
 * Get issues ready to pick up (status = Todo Refined or Todo Bug, unblocked).
 *
 * Uses the root `issues` query with team key filter. Checks `inverseRelations`
 * for blocking relationships — an issue is blocked if it has an inverseRelation
 * of type "blocks" from a non-completed issue.
 */
export async function getReadyIssues(apiKey: string, teamKey: string): Promise<LinearIssueCompact[]> {
  const data = (await linearQuery(apiKey, `
    query($teamKey: String!, $stateNames: [String!]!) {
      issues(
        filter: {
          team: { key: { eq: $teamKey } }
          state: { name: { in: $stateNames } }
        }
        first: 50
      ) {
        nodes {
          identifier
          title
          priority
          state { name type }
          inverseRelations {
            nodes {
              type
              issue {
                identifier
                state { name type }
              }
            }
          }
        }
      }
    }
  `, { teamKey, stateNames: ['Todo Refined', 'Todo Bug'] })) as {
    issues: {
      nodes: (LinearIssueCompact & {
        inverseRelations: {
          nodes: {
            type: string;
            issue: { identifier: string; state: { name: string; type: string } };
          }[];
        };
      })[];
    };
  };

  // Filter out blocked issues: those with inverseRelations of type "blocks"
  // where the blocking issue is not yet completed.
  // inverseRelation type "blocks" + issue = the blocker (the issue that blocks this one).
  return data.issues.nodes.filter((issue) => {
    const blockers = issue.inverseRelations.nodes.filter(
      (rel) => rel.type === 'blocks' && rel.issue.state.type !== 'completed',
    );
    return blockers.length === 0;
  });
}

/**
 * Get blocked issues with their blockers.
 *
 * An issue is "blocked" if it has an inverseRelation of type "blocks" from
 * a non-completed issue. The `issue` field in inverseRelations is the blocker.
 */
export async function getBlockedIssues(apiKey: string, teamKey: string): Promise<
  { issue: LinearIssueCompact; blockedBy: { identifier: string; title: string }[] }[]
> {
  const data = (await linearQuery(apiKey, `
    query($teamKey: String!) {
      issues(
        filter: {
          team: { key: { eq: $teamKey } }
          state: { type: { nin: ["completed", "canceled"] } }
        }
        first: 100
      ) {
        nodes {
          identifier
          title
          priority
          state { name type }
          inverseRelations {
            nodes {
              type
              issue {
                identifier
                title
                state { name type }
              }
            }
          }
        }
      }
    }
  `, { teamKey })) as {
    issues: {
      nodes: (LinearIssueCompact & {
        inverseRelations: {
          nodes: {
            type: string;
            issue: { identifier: string; title: string; state: { name: string; type: string } };
          }[];
        };
      })[];
    };
  };

  const blocked: { issue: LinearIssueCompact; blockedBy: { identifier: string; title: string }[] }[] = [];

  for (const issue of data.issues.nodes) {
    const openBlockers = issue.inverseRelations.nodes
      .filter((rel) => rel.type === 'blocks' && rel.issue.state.type !== 'completed')
      .map((rel) => ({ identifier: rel.issue.identifier, title: rel.issue.title }));

    if (openBlockers.length > 0) {
      blocked.push({ issue, blockedBy: openBlockers });
    }
  }

  return blocked;
}

/**
 * Look up the team UUID from a team key (e.g. "AGE" → UUID).
 * Cached per request — called internally by functions that need it.
 */
async function getTeamId(apiKey: string, teamKey: string): Promise<string> {
  const data = (await linearQuery(apiKey, `
    query($teamKey: String!) {
      teams(filter: { key: { eq: $teamKey } }) {
        nodes { id }
      }
    }
  `, { teamKey })) as { teams: { nodes: { id: string }[] } };

  if (data.teams.nodes.length === 0) {
    throw new Error(`Team with key "${teamKey}" not found`);
  }
  return data.teams.nodes[0].id;
}

/**
 * Update an issue's workflow state.
 */
export async function updateIssueStatus(
  apiKey: string,
  identifier: string,
  lbStatus: string,
): Promise<{ success: boolean; newState: string }> {
  const linearStateName = LB_TO_LINEAR_STATE[lbStatus];
  if (!linearStateName) {
    throw new Error(
      `Unknown status "${lbStatus}". Valid: ${Object.keys(LB_TO_LINEAR_STATE).join(', ')}`,
    );
  }

  // Get the issue to find its UUID for the mutation
  const issue = await getIssue(apiKey, identifier);
  if (!issue) throw new Error(`Issue ${identifier} not found`);

  // Look up the team UUID via teams query with key filter
  const teamKey = identifier.split('-')[0];
  const teamId = await getTeamId(apiKey, teamKey);

  // Find the target workflow state using the team UUID
  const statesData = (await linearQuery(apiKey, `
    query($teamId: String!) {
      team(id: $teamId) {
        states { nodes { id name type } }
      }
    }
  `, { teamId })) as { team: { states: { nodes: { id: string; name: string; type: string }[] } } };

  const targetState = statesData.team.states.nodes.find((s) => s.name === linearStateName);
  if (!targetState) {
    const available = statesData.team.states.nodes.map((s) => s.name).join(', ');
    throw new Error(`Workflow state "${linearStateName}" not found in team ${teamKey}. Available: ${available}`);
  }

  // Update the issue
  await linearQuery(apiKey, `
    mutation($id: String!, $stateId: String!) {
      issueUpdate(id: $id, input: { stateId: $stateId }) {
        success
      }
    }
  `, { id: issue.id, stateId: targetState.id });

  return { success: true, newState: linearStateName };
}

/**
 * Create a new issue.
 */
export async function createIssue(
  apiKey: string,
  teamKey: string,
  title: string,
  options?: { description?: string; parentIdentifier?: string; labels?: string[] },
): Promise<{ identifier: string; title: string }> {
  // Look up team UUID via teams query with key filter
  const teamId = await getTeamId(apiKey, teamKey);

  const input: Record<string, unknown> = {
    teamId,
    title,
    description: options?.description ?? '',
  };

  // If parent, find its UUID
  if (options?.parentIdentifier) {
    const parent = await getIssue(apiKey, options.parentIdentifier);
    if (parent) input.parentId = parent.id;
  }

  // Attach labels if specified (look up by name, skip missing ones with warning)
  if (options?.labels?.length) {
    const labelsData = (await linearQuery(apiKey, `
      query($teamId: String!) {
        team(id: $teamId) {
          labels { nodes { id name } }
        }
      }
    `, { teamId })) as { team: { labels: { nodes: { id: string; name: string }[] } } };

    const labelIds: string[] = [];
    for (const name of options.labels) {
      const found = labelsData.team.labels.nodes.find(
        (l) => l.name.toLowerCase() === name.toLowerCase(),
      );
      if (found) {
        labelIds.push(found.id);
      }
      // Labels not found are silently skipped — Linear auto-creates them
      // in the UI but not via API. Consider creating them if needed.
    }

    if (labelIds.length) input.labelIds = labelIds;
  }

  const data = (await linearQuery(apiKey, `
    mutation($input: IssueCreateInput!) {
      issueCreate(input: $input) {
        success
        issue { identifier title }
      }
    }
  `, { input })) as { issueCreate: { success: boolean; issue: { identifier: string; title: string } } };

  return data.issueCreate.issue;
}
