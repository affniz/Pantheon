import React from "react";
import { Box, Text } from "ink";
import type { ToolCall, ToolResult } from "@pantheon/shared";
import { theme } from "./theme.js";

interface ToolCallDisplayProps {
    call: ToolCall;
    safety: "safe" | "destructive";
}

/**
 * Renders a tool call — shows the tool name and arguments
 * in a distinctive branded style.
 */
export function ToolCallDisplay({ call, safety }: ToolCallDisplayProps) {
    const argsStr = formatArgs(call.arguments);
    const safetyColor =
        safety === "destructive" ? theme.colors.warning : theme.colors.accent;
    const safetyLabel =
        safety === "destructive" ? "⚠ destructive" : "safe";

    return (
        <Box flexDirection="column" marginLeft={2} marginTop={0} marginBottom={0}>
            <Text>
                <Text color={safetyColor}>{"  🔧 "}</Text>
                <Text color={theme.colors.primary} bold>
                    {call.name}
                </Text>
                <Text color={theme.colors.textDim}>{"("}</Text>
                <Text color={theme.colors.text}>{argsStr}</Text>
                <Text color={theme.colors.textDim}>{")"}</Text>
                <Text color={theme.colors.textDim}>{" "}{safetyLabel}</Text>
            </Text>
        </Box>
    );
}

interface ToolResultDisplayProps {
    result: ToolResult;
}

/**
 * Renders a tool result — shows success/error status and a truncated summary.
 */
export function ToolResultDisplay({ result }: ToolResultDisplayProps) {
    const statusColor = result.isError ? theme.colors.error : theme.colors.success;
    const statusSymbol = result.isError ? theme.symbols.cross : theme.symbols.check;

    // Truncate content for display
    const lines = result.content.split("\n");
    const lineCount = lines.length;
    const preview = lineCount > 3
        ? lines.slice(0, 3).join("\n") + `\n  … (${lineCount} lines total)`
        : result.content;

    return (
        <Box flexDirection="column" marginLeft={4} marginBottom={1}>
            <Text>
                <Text color={theme.colors.textDim}>{"↳ "}</Text>
                <Text color={statusColor}>{statusSymbol} </Text>
                <Text color={theme.colors.textDim}>
                    {result.isError ? "Error" : "Done"}
                    {" · "}
                    {lineCount} line{lineCount !== 1 ? "s" : ""}
                </Text>
            </Text>
            <Box marginLeft={2}>
                <Text color={theme.colors.textDim} wrap="truncate-end">
                    {preview}
                </Text>
            </Box>
        </Box>
    );
}

function formatArgs(args: Record<string, unknown>): string {
    const entries = Object.entries(args);
    if (entries.length === 0) return "";

    return entries
        .map(([key, value]) => {
            const v = typeof value === "string"
                ? `"${value.length > 60 ? value.slice(0, 60) + "…" : value}"`
                : JSON.stringify(value);
            return `${key}: ${v}`;
        })
        .join(", ");
}
