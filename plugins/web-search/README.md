# @pantheon-plugins/web-search

Web search plugin for Pantheon. Enables agents to search the web in real-time using [Tavily](https://tavily.com) (preferred) or [Brave Search](https://brave.com/search/api) APIs.

## Installation

```bash
# Set at least one API key
export TAVILY_API_KEY=tvly-your-key-here
# or: export BRAVE_SEARCH_API_KEY=BSA-your-key-here

pantheon plugins install ./plugins/web-search
```

## Available Tools

### `web-search.search`

Search the web for up-to-date information.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | ✓ | The search query |
| `numResults` | number | | Number of results (1-10, default: 5) |
| `searchDepth` | string | | `"basic"` (fast) or `"advanced"` (thorough) |

## Usage

```
pantheon chat "Search the web for the latest TypeScript 5.5 features"
pantheon chat "Find the current Node.js LTS version"
pantheon chat "Search for best practices for React Server Components in 2024"
```

## API Keys

**Tavily** (recommended):
- Sign up at https://tavily.com
- Free tier: 1,000 searches/month
- Set `TAVILY_API_KEY=tvly-...`

**Brave Search** (fallback):
- Sign up at https://brave.com/search/api
- Free tier: 2,000 searches/month
- Set `BRAVE_SEARCH_API_KEY=BSA-...`

Tavily is preferred when both keys are set.
