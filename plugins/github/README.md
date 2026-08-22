# @pantheon-plugins/github

GitHub integration plugin for Pantheon, powered by the official [MCP GitHub server](https://github.com/modelcontextprotocol/servers/tree/main/src/github).

## Prerequisites

- A GitHub personal access token with `repo`, `issues`, and `pull_requests` scopes
- `npx` available in your PATH

## Installation

```bash
export GITHUB_TOKEN=ghp_your_token_here
pantheon plugins install ./plugins/github
```

## Available Tools

Tools are auto-discovered from the MCP server on startup:

| Tool | Description |
|------|-------------|
| `create_issue` | Create a new issue in a repository |
| `list_issues` | List issues with optional filters |
| `get_issue` | Get issue details by number |
| `create_pull_request` | Open a pull request |
| `list_pull_requests` | List PRs with optional filters |
| `search_code` | Full-text code search across GitHub |
| `get_file_contents` | Read a file from a repository |
| `create_or_update_file` | Create or update a file in a repository |
| `fork_repository` | Fork a repository |
| `create_branch` | Create a new branch |

## Usage

Once installed, the GitHub tools are automatically available to all agents:

```
pantheon chat "List all open issues in owner/repo that are labeled 'bug'"
pantheon chat "Create a PR from feature/my-branch to main with the title 'Add feature X'"
pantheon chat "Search for all usages of deprecated_function in the owner/repo codebase"
```

## Configuration

Set required environment variables before starting Pantheon:

```bash
export GITHUB_TOKEN=ghp_xxxxxxxxxxxx
```

Or add to your shell profile (`.bashrc`, `.zshrc`).

## Security

- GitHub tools are classified as `destructive` (they can modify repositories)
- The permission system will prompt before each write operation unless you set "Always Allow"
- The MCP server only has access to repositories within your token's scope
