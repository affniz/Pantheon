# @pantheon-plugins/jira

Jira integration plugin for Pantheon, powered by the [MCP Atlassian server](https://github.com/sooperset/mcp-atlassian).

## Prerequisites

- Jira Cloud or Data Center instance
- A Jira API token (not your password)
- `npx` available in your PATH

## Installation

```bash
export JIRA_URL=https://your-org.atlassian.net
export JIRA_USERNAME=your-email@company.com
export JIRA_API_TOKEN=your-api-token

pantheon plugins install ./plugins/jira
```

## Available Tools

Tools are auto-discovered from the MCP server on startup:

| Tool | Description |
|------|-------------|
| `get_issue` | Get issue details by key (e.g. PROJECT-123) |
| `search_issues` | Search issues using JQL |
| `create_issue` | Create a new issue |
| `update_issue` | Update issue fields |
| `add_comment` | Add a comment to an issue |
| `get_project` | Get project details |
| `list_projects` | List all accessible projects |
| `get_sprint` | Get sprint details |
| `list_sprints` | List sprints for a board |

## Usage

```
pantheon chat "List all open bugs in the BACKEND project assigned to me"
pantheon chat "Create a Jira issue for the login page timeout bug we discussed"
pantheon chat "What's the status of ticket PROJ-4521?"
pantheon chat "Add a comment to PROJ-100 saying the fix is ready for review"
```

## API Token

Create a Jira API token at:
https://id.atlassian.com/manage-profile/security/api-tokens

Use this token (not your Atlassian password) as `JIRA_API_TOKEN`.
