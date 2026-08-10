import chalk from "chalk";
import type { Span } from "@pantheon/shared";

const KIND_COLORS: Record<string, (s: string) => string> = {
    http: chalk.blue,
    routing: chalk.magenta,
    llm: chalk.cyan,
    tool: chalk.yellow,
    agent: chalk.green,
    internal: chalk.gray,
};

function kindTag(kind: string): string {
    const color = KIND_COLORS[kind] ?? chalk.white;
    return color(`[${kind.toUpperCase().padEnd(7)}]`);
}

function statusIcon(status: string): string {
    return status === "ok" ? chalk.green("✓") : chalk.red("✗");
}

function bar(durationMs: number, totalMs: number, width = 20): string {
    const filled = totalMs > 0 ? Math.round((durationMs / totalMs) * width) : 0;
    return chalk.dim("█".repeat(filled) + "░".repeat(Math.max(0, width - filled)));
}

/**
 * Render a trace waterfall to stdout.
 * Spans are arranged as an indented tree, each showing offset from trace start,
 * duration, a proportional bar, and status.
 */
export function renderTraceWaterfall(spans: Span[]): void {
    if (spans.length === 0) {
        console.log(chalk.dim("  No spans found for this trace."));
        return;
    }

    // Find the root span (no parent)
    const root = spans.find((s) => !s.parentSpanId) ?? spans[0]!;
    const traceStart = root.startTime;
    const totalMs = root.durationMs ?? 1;

    // Build parent → children map
    const childrenOf = new Map<string, Span[]>();
    for (const span of spans) {
        if (span.parentSpanId) {
            const list = childrenOf.get(span.parentSpanId) ?? [];
            list.push(span);
            childrenOf.set(span.parentSpanId, list);
        }
    }

    console.log("");
    console.log(
        `  ${chalk.bold("Trace")} ${chalk.dim(root.traceId)}`
    );
    console.log(
        `  ${chalk.dim("Duration:")} ${chalk.white(`${totalMs}ms`)}  ` +
        `${chalk.dim("Spans:")} ${chalk.white(spans.length)}  ` +
        `${chalk.dim("Status:")} ${statusIcon(root.status)}`
    );
    console.log("");
    console.log(
        `  ${chalk.dim("SPAN".padEnd(45))} ${"OFFSET".padEnd(10)} ${"DURATION".padEnd(10)} ${"BAR".padEnd(22)} STATUS`
    );
    console.log(`  ${chalk.dim("─".repeat(95))}`);

    function printNode(span: Span, prefix: string, isLast: boolean): void {
        const offset = `+${span.startTime - traceStart}ms`;
        const duration = `${span.durationMs ?? 0}ms`;
        const connector = isLast ? "└── " : "├── ";
        const label = `${kindTag(span.kind)} ${span.name}`;
        const barStr = bar(span.durationMs ?? 0, totalMs);

        // Pad the label (kind tag is ~13 chars + space + name)
        const labelRaw = `[${span.kind.toUpperCase().padEnd(7)}] ${span.name}`;
        const padded = labelRaw.padEnd(40);

        process.stdout.write(
            `  ${prefix}${connector}${kindTag(span.kind)} ${span.name.padEnd(Math.max(0, 38 - span.kind.length))} ` +
            `${chalk.dim(offset.padEnd(10))}` +
            `${chalk.white(duration.padEnd(10))}` +
            `${barStr}  ` +
            `${statusIcon(span.status)}\n`
        );

        const children = (childrenOf.get(span.spanId) ?? []).sort(
            (a, b) => a.startTime - b.startTime
        );
        const childPrefix = prefix + (isLast ? "    " : "│   ");
        children.forEach((child, i) => {
            printNode(child, childPrefix, i === children.length - 1);
        });
    }

    printNode(root, "", true);
    console.log(`  ${chalk.dim("─".repeat(95))}`);
    console.log("");
}
