import * as fs from "node:fs";
import * as path from "node:path";
import type { Sandbox } from "../sandbox/sandbox.js";

export interface VerificationResult {
    /** True when every check that ran succeeded (also true when nothing could be checked). */
    passed: boolean;
    /** False when the project has neither a tsconfig.json nor a recognisable test command. */
    ran: boolean;
    /** One line per check, e.g. "TypeScript compilation: PASSED". */
    notes: string[];
    /** Compiler / test output of the failing checks, trimmed — fed to the fixing agent. */
    failures: string;
}

/** Detect the project's test command from package.json, or null when there is none. */
export function detectTestCommand(projectRoot: string): { bin: string; args: string[] } | null {
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf-8")) as {
            scripts?: Record<string, string>;
        };
        const scripts = pkg.scripts ?? {};

        if (scripts["vitest"]) return { bin: "pnpm", args: ["vitest", "run"] };
        if (scripts["test"]) {
            const cmd = scripts["test"];
            if (cmd.includes("vitest")) return { bin: "pnpm", args: ["vitest", "run"] };
            if (cmd.includes("jest")) return { bin: "pnpm", args: ["jest", "--passWithNoTests"] };
            return { bin: "pnpm", args: ["test"] };
        }
        return null;
    } catch {
        return null;
    }
}

/**
 * Run a fixed verification command through the sandbox's executor.
 *
 * These commands are chosen by Pantheon, not by a model, so they skip the shell
 * allowlist — but they still run where every other command runs: in the container
 * in docker mode, and with credentials stripped from the environment on the host.
 */
async function runCheck(sandbox: Sandbox, bin: string, args: string[], timeoutMs: number): Promise<{ success: boolean; output: string }> {
    const result = await sandbox.executor.run({
        command: [bin, ...args].join(" "),
        cwd: sandbox.projectRoot,
        timeoutMs,
        maxBuffer: 1024 * 512,
    });
    const output = [result.stdout, result.stderr, result.spawnError, result.timedOut ? `(timed out after ${timeoutMs}ms)` : ""]
        .filter(Boolean)
        .join("\n")
        .trim();
    return { success: result.exitCode === 0 && !result.timedOut && !result.spawnError, output };
}

const MAX_FAILURE_CHARS = 3000;

/** Keep the end of long output: compilers and test runners put the summary last. */
function tail(output: string): string {
    return output.length <= MAX_FAILURE_CHARS ? output : "…\n" + output.slice(-MAX_FAILURE_CHARS);
}

/**
 * Check that the project still compiles and its tests pass.
 *
 * - TypeScript: `tsc --noEmit`, only when the project root has a tsconfig.json
 *   (without one tsc fails with "No inputs were found").
 * - Tests: the command detected from package.json, if any.
 */
export async function runVerification(sandbox: Sandbox): Promise<VerificationResult> {
    const notes: string[] = [];
    const failures: string[] = [];
    let ran = false;

    if (fs.existsSync(path.join(sandbox.projectRoot, "tsconfig.json"))) {
        ran = true;
        const tsc = await runCheck(sandbox, "npx", ["tsc", "--noEmit"], 60_000);
        if (tsc.success) {
            notes.push("TypeScript compilation: PASSED");
        } else {
            notes.push("TypeScript compilation: FAILED");
            failures.push("TypeScript compilation FAILED:\n" + tail(tsc.output));
        }
    } else {
        notes.push("TypeScript compilation: skipped (no tsconfig.json in project root)");
    }

    const testCmd = detectTestCommand(sandbox.projectRoot);
    if (testCmd) {
        ran = true;
        const tests = await runCheck(sandbox, testCmd.bin, testCmd.args, 120_000);
        if (tests.success) {
            notes.push("Test suite: PASSED");
        } else {
            notes.push("Test suite: FAILED");
            failures.push("Test suite FAILED:\n" + tail(tests.output));
        }
    } else {
        notes.push("Test suite: no test command detected in package.json");
    }

    return { passed: failures.length === 0, ran, notes, failures: failures.join("\n\n") };
}
