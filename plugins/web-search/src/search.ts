import type { Sandbox } from "@pantheon/core";

interface SearchArgs {
    query: string;
    numResults?: number;
    searchDepth?: "basic" | "advanced";
}

interface TavilySearchResult {
    title: string;
    url: string;
    content: string;
    score: number;
    published_date?: string;
}

interface TavilyResponse {
    results: TavilySearchResult[];
    answer?: string;
}

interface BraveWebResult {
    title: string;
    url: string;
    description: string;
}

interface BraveResponse {
    web?: {
        results: BraveWebResult[];
    };
}

/**
 * Web search tool handler for the @pantheon-plugins/web-search plugin.
 * Supports Tavily (preferred) and Brave Search (fallback) APIs.
 *
 * Install:
 *   export TAVILY_API_KEY=tvly-xxxx   # preferred
 *   export BRAVE_SEARCH_API_KEY=BSA-xxx  # or use Brave
 *   pantheon plugins install ./plugins/web-search
 */
export async function execute(
    args: Record<string, unknown>,
    _sandbox: Sandbox
): Promise<string> {
    const { query, numResults = 5, searchDepth = "basic" } = args as SearchArgs;

    if (!query || typeof query !== "string") {
        return "Error: 'query' must be a non-empty string";
    }

    const n = Math.min(Math.max(1, Number(numResults) || 5), 10);

    const tavilyKey = process.env["TAVILY_API_KEY"];
    const braveKey = process.env["BRAVE_SEARCH_API_KEY"];

    if (!tavilyKey && !braveKey) {
        return (
            "Error: No search API key configured. " +
            "Set TAVILY_API_KEY (https://tavily.com) or BRAVE_SEARCH_API_KEY (https://brave.com/search/api) " +
            "in your environment variables."
        );
    }

    try {
        if (tavilyKey) {
            return await tavilySearch(query, n, searchDepth, tavilyKey);
        } else {
            return await braveSearch(query, n, braveKey!);
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return `Error performing web search: ${message}`;
    }
}

async function tavilySearch(
    query: string,
    numResults: number,
    searchDepth: "basic" | "advanced",
    apiKey: string
): Promise<string> {
    const response = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
            query,
            max_results: numResults,
            search_depth: searchDepth,
            include_answer: true,
            include_raw_content: false,
        }),
        signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`Tavily API returned HTTP ${response.status}: ${body.slice(0, 200)}`);
    }

    const data = await response.json() as TavilyResponse;
    return formatTavilyResults(query, data);
}

async function braveSearch(
    query: string,
    numResults: number,
    apiKey: string
): Promise<string> {
    const url = new URL("https://api.search.brave.com/res/v1/web/search");
    url.searchParams.set("q", query);
    url.searchParams.set("count", String(numResults));
    url.searchParams.set("text_decorations", "false");

    const response = await fetch(url.toString(), {
        headers: {
            Accept: "application/json",
            "Accept-Encoding": "gzip",
            "X-Subscription-Token": apiKey,
        },
        signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`Brave Search API returned HTTP ${response.status}: ${body.slice(0, 200)}`);
    }

    const data = await response.json() as BraveResponse;
    return formatBraveResults(query, data);
}

function formatTavilyResults(query: string, data: TavilyResponse): string {
    const lines: string[] = [`Web search results for: "${query}"`, ""];

    if (data.answer) {
        lines.push(`Summary: ${data.answer}`, "");
    }

    if (!data.results || data.results.length === 0) {
        lines.push("No results found.");
        return lines.join("\n");
    }

    data.results.forEach((result, i) => {
        lines.push(`${i + 1}. **${result.title}**`);
        lines.push(`   URL: ${result.url}`);
        if (result.published_date) {
            lines.push(`   Published: ${result.published_date}`);
        }
        const snippet = result.content.slice(0, 300).replace(/\n+/g, " ");
        lines.push(`   ${snippet}${result.content.length > 300 ? "..." : ""}`);
        lines.push("");
    });

    return lines.join("\n").trimEnd();
}

function formatBraveResults(query: string, data: BraveResponse): string {
    const lines: string[] = [`Web search results for: "${query}"`, ""];
    const results = data.web?.results ?? [];

    if (results.length === 0) {
        lines.push("No results found.");
        return lines.join("\n");
    }

    results.forEach((result, i) => {
        lines.push(`${i + 1}. **${result.title}**`);
        lines.push(`   URL: ${result.url}`);
        const snippet = result.description.slice(0, 300).replace(/\n+/g, " ");
        lines.push(`   ${snippet}${result.description.length > 300 ? "..." : ""}`);
        lines.push("");
    });

    return lines.join("\n").trimEnd();
}
