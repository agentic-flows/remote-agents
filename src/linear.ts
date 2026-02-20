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
}

export interface LinearIssueCompact {
  identifier: string;
  title: string;
  priority: number;
  state: { name: string; type: string };
}

// Map lb status names to Linear workflow state names
// Linear uses title-case "In Progress" while lb uses snake_case "in_progress"
const LB_TO_LINEAR_STATE: Record<string, string> = {
  todo_needs_refinement: 'Todo - Needs Refinement',
  todo_refined: 'Todo - Refined',
  todo_bug: 'Todo - Bug',
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
 */
export async function getIssue(apiKey: string, identifier: string): Promise<LinearIssue | null> {
  const teamKey = identifier.split('-')[0];
  const number = parseInt(identifier.split('-')[1], 10);

  const data = (await linearQuery(apiKey, `
    query($teamKey: String!, $number: Float!) {
      issueVcsByTeamKeyAndNumber(teamKey: $teamKey, number: $number) {
        id
        identifier
        title
        description
        priority
        state { name type }
        parent { identifier title }
        children { nodes { identifier title state { name type } } }
        relations { nodes { type relatedIssue { identifier title state { name type } } } }
      }
    }
  `, { teamKey, number })) as { issueVcsByTeamKeyAndNumber: LinearIssue | null };

  return data.issueVcsByTeamKeyAndNumber;
}

/**
 * List issues for a team, optionally filtered by state type.
 */
export async function listIssues(
  apiKey: string,
  teamKey: string,
  options?: { stateNames?: string[]; first?: number },
): Promise<LinearIssueCompact[]> {
  const stateFilter = options?.stateNames?.length
    ? `state: { name: { in: ${JSON.stringify(options.stateNames)} } }`
    : '';

  const data = (await linearQuery(apiKey, `
    query($teamKey: String!, $first: Int) {
      team(id: $teamKey) {
        issues(first: $first, ${stateFilter ? `filter: { ${stateFilter} }` : ''}) {
          nodes {
            identifier
            title
            priority
            state { name type }
          }
        }
      }
    }
  `, { teamKey, first: options?.first ?? 50 })) as { team: { issues: { nodes: LinearIssueCompact[] } } };

  return data.team.issues.nodes;
}

/**
 * Get issues ready to pick up (status = Todo - Refined or Todo - Bug, unblocked).
 */
export async function getReadyIssues(apiKey: string, teamKey: string): Promise<LinearIssueCompact[]> {
  // Query for refined and bug issues
  const data = (await linearQuery(apiKey, `
    query($teamKey: String!) {
      team(id: $teamKey) {
        issues(
          filter: {
            state: { name: { in: ["Todo - Refined", "Todo - Bug"] } }
          }
          first: 50
        ) {
          nodes {
            identifier
            title
            priority
            state { name type }
            relations {
              nodes {
                type
                relatedIssue {
                  identifier
                  state { name type }
                }
              }
            }
          }
        }
      }
    }
  `, { teamKey })) as {
    team: {
      issues: {
        nodes: (LinearIssueCompact & {
          relations: {
            nodes: {
              type: string;
              relatedIssue: { identifier: string; state: { name: string; type: string } };
            }[];
          };
        })[];
      };
    };
  };

  // Filter out blocked issues (those with "blocks" relation where blocker is not done)
  return data.team.issues.nodes.filter((issue) => {
    const blockers = issue.relations.nodes.filter(
      (rel) => rel.type === 'blocks' && rel.relatedIssue.state.type !== 'completed',
    );
    return blockers.length === 0;
  });
}

/**
 * Get blocked issues with their blockers.
 */
export async function getBlockedIssues(apiKey: string, teamKey: string): Promise<
  { issue: LinearIssueCompact; blockedBy: { identifier: string; title: string }[] }[]
> {
  const data = (await linearQuery(apiKey, `
    query($teamKey: String!) {
      team(id: $teamKey) {
        issues(
          filter: {
            state: { type: { nin: ["completed", "canceled"] } }
          }
          first: 100
        ) {
          nodes {
            identifier
            title
            priority
            state { name type }
            relations {
              nodes {
                type
                relatedIssue {
                  identifier
                  title
                  state { name type }
                }
              }
            }
          }
        }
      }
    }
  `, { teamKey })) as {
    team: {
      issues: {
        nodes: (LinearIssueCompact & {
          relations: {
            nodes: {
              type: string;
              relatedIssue: { identifier: string; title: string; state: { name: string; type: string } };
            }[];
          };
        })[];
      };
    };
  };

  const blocked: { issue: LinearIssueCompact; blockedBy: { identifier: string; title: string }[] }[] = [];

  for (const issue of data.team.issues.nodes) {
    const openBlockers = issue.relations.nodes
      .filter((rel) => rel.type === 'blocks' && rel.relatedIssue.state.type !== 'completed')
      .map((rel) => ({ identifier: rel.relatedIssue.identifier, title: rel.relatedIssue.title }));

    if (openBlockers.length > 0) {
      blocked.push({ issue, blockedBy: openBlockers });
    }
  }

  return blocked;
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

  // First get the issue to find its team
  const issue = await getIssue(apiKey, identifier);
  if (!issue) throw new Error(`Issue ${identifier} not found`);

  // Find the target workflow state
  const teamKey = identifier.split('-')[0];
  const statesData = (await linearQuery(apiKey, `
    query($teamKey: String!) {
      team(id: $teamKey) {
        states { nodes { id name type } }
      }
    }
  `, { teamKey })) as { team: { states: { nodes: { id: string; name: string; type: string }[] } } };

  const targetState = statesData.team.states.nodes.find((s) => s.name === linearStateName);
  if (!targetState) {
    throw new Error(`Workflow state "${linearStateName}" not found in team ${teamKey}`);
  }

  // Update
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
  // Get team ID
  const teamData = (await linearQuery(apiKey, `
    query($teamKey: String!) {
      team(id: $teamKey) { id }
    }
  `, { teamKey })) as { team: { id: string } };

  const input: Record<string, unknown> = {
    teamId: teamData.team.id,
    title,
    description: options?.description ?? '',
  };

  // If parent, find its ID
  if (options?.parentIdentifier) {
    const parent = await getIssue(apiKey, options.parentIdentifier);
    if (parent) input.parentId = parent.id;
  }

  // Create labels if specified
  if (options?.labels?.length) {
    const labelsData = (await linearQuery(apiKey, `
      query($teamId: String!) {
        team(id: $teamId) {
          labels { nodes { id name } }
        }
      }
    `, { teamId: teamData.team.id })) as { team: { labels: { nodes: { id: string; name: string }[] } } };

    const labelIds = options.labels.map((name) => {
      const found = labelsData.team.labels.nodes.find(
        (l) => l.name.toLowerCase() === name.toLowerCase(),
      );
      return found?.id;
    }).filter(Boolean);

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
