import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import type { PermissionDecision } from "@pantheon/core";
import { theme } from "./theme.js";

interface ToolPermissionProps {
    toolName: string;
    args: Record<string, unknown>;
    safety: "safe" | "destructive";
    onDecision: (decision: PermissionDecision) => void;
}

/**
 * Two-tier permission prompt for tool calls.
 *
 * Safe tools: [a] allow once  [A] always allow  [n] deny
 * Destructive tools: [y] approve  [n] deny
 */
export function ToolPermission({
    toolName,
    args,
    safety,
    onDecision,
}: ToolPermissionProps) {
    const [answered, setAnswered] = useState(false);

    useInput((input) => {
        if (answered) return;

        if (safety === "destructive") {
            if (input === "y" || input === "Y") {
                setAnswered(true);
                onDecision("allow_once");
            } else if (input === "n" || input === "N") {
                setAnswered(true);
                onDecision("deny");
            }
        } else {
            // Safe tool
            if (input === "a") {
                setAnswered(true);
                onDecision("allow_once");
            } else if (input === "A") {
                setAnswered(true);
                onDecision("always_allow");
            } else if (input === "n" || input === "N") {
                setAnswered(true);
                onDecision("deny");
            }
        }
    });

    if (answered) return null;

    const argsPreview = formatArgsShort(args);

    if (safety === "destructive") {
        return (
            <Box flexDirection="column" marginLeft={4}>
                <Text>
                    <Text color={theme.colors.warning}>⚠ Destructive operation</Text>
                    <Text color={theme.colors.textDim}>{" — "}</Text>
                    <Text color={theme.colors.text}>{toolName}</Text>
                    <Text color={theme.colors.textDim}>
                        {argsPreview ? `: ${argsPreview}` : ""}
                    </Text>
                </Text>
                <Text>
                    <Text color={theme.colors.success}> [y]</Text>
                    <Text color={theme.colors.textDim}> approve  </Text>
                    <Text color={theme.colors.error}>[n]</Text>
                    <Text color={theme.colors.textDim}> deny</Text>
                </Text>
            </Box>
        );
    }

    // Safe tool
    return (
        <Box flexDirection="column" marginLeft={4}>
            <Text>
                <Text color={theme.colors.accent}>First use of </Text>
                <Text color={theme.colors.text} bold>{toolName}</Text>
            </Text>
            <Text>
                <Text color={theme.colors.success}> [a]</Text>
                <Text color={theme.colors.textDim}> allow once  </Text>
                <Text color={theme.colors.primary}>[A]</Text>
                <Text color={theme.colors.textDim}> always allow  </Text>
                <Text color={theme.colors.error}>[n]</Text>
                <Text color={theme.colors.textDim}> deny</Text>
            </Text>
        </Box>
    );
}

function formatArgsShort(args: Record<string, unknown>): string {
    const entries = Object.entries(args);
    if (entries.length === 0) return "";

    // Show just the first meaningful arg value
    const first = entries[0];
    if (!first) return "";

    const [key, value] = first;
    if (typeof value === "string") {
        return value.length > 50 ? value.slice(0, 50) + "…" : value;
    }
    return `${key}: ${JSON.stringify(value)}`;
}
