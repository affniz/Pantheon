import { execSync, execFileSync } from "node:child_process";
import chalk from "chalk";
import { getCapabilities } from "@pantheon/core";

const brand = chalk.hex("#F5A623");
const dim = chalk.hex("#6B7280");
const ok = chalk.green("  ✓");
const warn = chalk.yellow("  ⚠");
const fail = chalk.red("  ✗");

interface CheckResult {
    label: string;
    passed: boolean;
    warning?: boolean | undefined;
    value?: string | undefined;
    hint?: string | undefined;
}

function checkNodeVersion(): CheckResult {
    const version = process.version;
    const major = parseInt(version.slice(1).split(".")[0]!, 10);
    return {
        label: "Node.js",
        passed: major >= 20,
        value: version,
        ...(major < 20 ? { hint: "Node.js v20+ is required. Install at https://nodejs.org/" } : {}),
    };
}

function checkPnpm(): CheckResult {
    try {
        const out = execFileSync("pnpm", ["--version"], { encoding: "utf-8" }).trim();
        const major = parseInt(out.split(".")[0]!, 10);
        return {
            label: "pnpm",
            passed: major >= 9,
            value: "v" + out,
            ...(major < 9 ? { hint: "pnpm v9+ required. Run: npm install -g pnpm" } : {}),
        };
    } catch {
        return {
            label: "pnpm",
            passed: false,
            warning: true,
            hint: "pnpm not found. Install at https://pnpm.io/ or use npm.",
        };
    }
}

function checkDocker(): CheckResult {
    try {
        execSync("docker info", { stdio: "pipe", timeout: 5000 });
        return { label: "Docker", passed: true, value: "running" } as CheckResult;
    } catch {
        return {
            label: "Docker",
            passed: false,
            hint: "Docker daemon not running. Start Docker Desktop or sudo systemctl start docker.",
        };
    }
}

async function checkGateway(): Promise<CheckResult> {
    const gatewayUrl = process.env["LITELLM_BASE_URL"] ?? "http://localhost:4000";
    const start = Date.now();
    try {
        const res = await fetch(gatewayUrl + "/health", { signal: AbortSignal.timeout(5000) });
        const ms = Date.now() - start;
        return {
            label: "LiteLLM gateway",
            passed: res.ok,
            value: res.ok ? "healthy at " + gatewayUrl + " (" + ms + "ms)" : res.status + " at " + gatewayUrl,
            ...(!res.ok ? { hint: "Gateway returned an error. Run: docker compose up -d" } : {}),
        };
    } catch {
        return {
            label: "LiteLLM gateway",
            passed: false,
            hint: "Could not reach " + gatewayUrl + ". Start it with: docker compose up -d",
        };
    }
}

async function checkApiKey(
    envVar: string,
    label: string,
    modelId: string,
    required: boolean
): Promise<CheckResult> {
    const key = process.env[envVar];
    if (!key) {
        return {
            label,
            passed: false,
            warning: !required,
            hint: required
                ? envVar + " not set. Add it to .env and restart."
                : envVar + " not set — orchestration and coding agents disabled. Add to .env to enable.",
        };
    }

    const gatewayUrl = process.env["LITELLM_BASE_URL"] ?? "http://localhost:4000";
    const masterKey = process.env["LITELLM_MASTER_KEY"] ?? "sk-pantheon-local";
    const start = Date.now();
    try {
        const res = await fetch(gatewayUrl + "/chat/completions", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": "Bearer " + masterKey },
            body: JSON.stringify({ model: modelId, messages: [{ role: "user", content: "hi" }], max_tokens: 1 }),
            signal: AbortSignal.timeout(10_000),
        });
        const ms = Date.now() - start;
        if (res.ok) {
            return { label, passed: true, value: "set and reachable (" + ms + "ms)" };
        }
        const body = await res.text().catch(() => "");
        return {
            label,
            passed: false,
            warning: !required,
            hint: envVar + " set but gateway returned " + res.status + ": " + body.slice(0, 100),
        };
    } catch {
        return {
            label,
            passed: false,
            warning: !required,
            hint: envVar + " set but could not reach model — is the gateway running?",
        };
    }
}

export async function doctorCommand(): Promise<void> {
    const caps = getCapabilities();

    console.log("");
    console.log("  " + brand.bold("◆") + " " + chalk.white.bold("Pantheon Doctor"));
    console.log("  " + dim("Checking prerequisites..."));
    console.log("");

    const results: CheckResult[] = [];

    results.push(checkNodeVersion());
    results.push(checkPnpm());
    results.push(checkDocker());
    results.push(await checkGateway());
    results.push(await checkApiKey("GROQ_API_KEY", "GROQ_API_KEY (routing)", "llama-smart", true));
    results.push(await checkApiKey("DEEPSEEK_API_KEY", "DEEPSEEK_API_KEY (coding agents)", "deepseek-v4-flash", false));

    if (!caps.anthropicFallbackEnabled && !caps.openaiFallbackEnabled) {
        results.push({
            label: "Fallback providers",
            passed: false,
            warning: true,
            hint: "No fallback keys set (ANTHROPIC_API_KEY / OPENAI_API_KEY). Add at least one for reliability.",
        });
    } else {
        const names: string[] = [];
        if (caps.anthropicFallbackEnabled) names.push("Anthropic");
        if (caps.openaiFallbackEnabled) names.push("OpenAI");
        results.push({ label: "Fallback providers", passed: true, value: names.join(", ") });
    }

    let passed = 0;
    let warnings = 0;
    let failures = 0;

    for (const r of results) {
        if (r.passed) {
            console.log(ok + " " + chalk.white(r.label) + (r.value ? "  " + dim(r.value) : ""));
            passed++;
        } else if (r.warning) {
            console.log(warn + " " + chalk.yellow(r.label) + (r.value ? "  " + dim(r.value) : ""));
            if (r.hint) console.log("     " + dim(r.hint));
            warnings++;
        } else {
            console.log(fail + " " + chalk.red(r.label) + (r.value ? "  " + dim(r.value) : ""));
            if (r.hint) console.log("     " + dim(r.hint));
            failures++;
        }
    }

    console.log("");
    console.log("  " + dim("─".repeat(55)));

    const total = results.length;
    if (failures === 0 && warnings === 0) {
        console.log("  " + chalk.green.bold("All checks passed") + " " + dim("(" + passed + "/" + total + ")") + " — Pantheon is fully operational.");
    } else if (failures === 0) {
        console.log("  " + chalk.yellow.bold(passed + "/" + total + " checks passed") + " — Pantheon is functional with limited capabilities.");
    } else {
        console.log("  " + chalk.red.bold(failures + " critical issue" + (failures > 1 ? "s" : "") + " found") + " — " + passed + " passed, " + warnings + " warnings, " + failures + " failed.");
        console.log("  " + dim("Fix the issues above and run `pantheon doctor` again."));
    }

    console.log("");
    if (failures > 0) process.exit(1);
}
