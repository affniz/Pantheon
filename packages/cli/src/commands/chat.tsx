import React, { useState, useMemo, useRef, useCallback } from "react";
import { render, Box, useInput } from "ink";
import chalk from "chalk";
import {
    ModelRegistry,
    Gateway,
    Sandbox,
    PermissionManager,
    ToolRegistry,
    registerBuiltinTools,
    AgentRuntime,
} from "@pantheon/core";
import type { PermissionDecision } from "@pantheon/core";
import type { ChatMessage, RoutingDecision, ToolCall, ToolResult } from "@pantheon/shared";
import { Message, StreamingMessage } from "../ui/message.js";
import { InputBox } from "../ui/input-box.js";
import { KeyHints } from "../ui/key-hints.js";
import { StatusBar } from "../ui/status-bar.js";
import { ToolCallDisplay, ToolResultDisplay } from "../ui/tool-call.js";
import { ToolPermission } from "../ui/tool-permission.js";

/** Events rendered inline during an agent turn */
type AgentEvent =
    | { type: "tool_call"; call: ToolCall; safety: "safe" | "destructive" }
    | { type: "tool_result"; result: ToolResult }
    | { type: "permission_prompt"; toolName: string; args: Record<string, unknown>; safety: "safe" | "destructive"; resolve: (decision: PermissionDecision) => void };

interface Props {
    modelId?: string;
    noTools?: boolean | undefined;
}

function ChatApp({ modelId: initialModelId, noTools = false }: Props) {
    const registry = useMemo(() => new ModelRegistry(), []);
    const gateway = useMemo(() => new Gateway(registry), []);

    // Tool system — only initialized when tools are enabled
    const sandbox = useMemo(
        () => (noTools ? null : Sandbox.create(process.cwd())),
        [noTools],
    );
    const toolRegistry = useMemo(() => {
        if (noTools) return null;
        const tr = new ToolRegistry();
        registerBuiltinTools(tr);
        return tr;
    }, [noTools]);

    const models = useMemo(() => registry.list(), [registry]);
    const modelOptions = useMemo(
        () => ["auto", ...models.map((m) => m.id)],
        [models],
    );

    const [selectedIndex, setSelectedIndex] = useState(() => {
        if (initialModelId) {
            const idx = modelOptions.indexOf(initialModelId);
            return idx >= 0 ? idx : 0;
        }
        return 0; // auto
    });

    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [input, setInput] = useState("");
    const [isStreaming, setIsStreaming] = useState(false);
    const [streamedText, setStreamedText] = useState("");
    const [decision, setDecision] = useState<RoutingDecision | null>(null);
    const [lastOutputChars, setLastOutputChars] = useState<number | null>(null);
    const [agentEvents, setAgentEvents] = useState<AgentEvent[]>([]);
    // Events from the last completed agentic turn — rendered between the user
    // message and the assistant response to preserve chronological order.
    const [completedEvents, setCompletedEvents] = useState<AgentEvent[]>([]);

    const currentOption = modelOptions[selectedIndex]!;
    const effectiveModelId = currentOption === "auto" ? undefined : currentOption;
    const isManual = currentOption !== "auto";
    const displayModelId = isManual
        ? currentOption
        : (registry.getDefault()?.id ?? "auto");

    useInput((ch, key) => {
        if (key.ctrl && ch.toLowerCase() === "c") process.exit(0);
        if (key.tab && !isStreaming) {
            setSelectedIndex((prev) => (prev + 1) % modelOptions.length);
        }
    });

    // Guard against double-submit: ink-text-input can fire onSubmit more than
    // once per Enter keypress when the terminal echoes stdin back to Node.
    const submittingRef = useRef(false);

    const handleSubmit = useCallback(async (value: string) => {
        if (!value.trim() || isStreaming || submittingRef.current) return;
        submittingRef.current = true;

        const userMessage: ChatMessage = {
            role: "user",
            content: value.trim(),
            timestamp: new Date(),
        };

        const updated = [...messages, userMessage];
        setMessages(updated);
        setInput("");
        setIsStreaming(true);
        setStreamedText("");
        setLastOutputChars(null);
        setAgentEvents([]);
        setCompletedEvents([]);

        if (noTools || !sandbox || !toolRegistry) {
            // Pure chat mode — v0.2 behavior
            const { generator, decision: newDecision } = await gateway.stream(
                updated,
                effectiveModelId,
            );
            setDecision(newDecision);

            let accumulated = "";
            for await (const chunk of generator) {
                accumulated += chunk;
                setStreamedText(accumulated);
            }

            setLastOutputChars(accumulated.length);
            setMessages([
                ...updated,
                { role: "assistant", content: accumulated, timestamp: new Date() },
            ]);
            setStreamedText("");
            setIsStreaming(false);
        } else {
            // Agentic mode — tool use enabled
            const permissionManager = new PermissionManager(
                (toolName: string, args: Record<string, unknown>, safety: "safe" | "destructive") => {
                    return new Promise<PermissionDecision>((resolve) => {
                        setAgentEvents((prev) => [
                            ...prev,
                            { type: "permission_prompt", toolName, args, safety, resolve },
                        ]);
                    });
                }
            );

            const agentRuntime = new AgentRuntime(gateway, toolRegistry, {
                maxIterations: 10,
                sandbox,
                permissionManager,
                onToolCall: (call: ToolCall, safety: "safe" | "destructive") => {
                    setAgentEvents((prev) => [
                        ...prev,
                        { type: "tool_call", call, safety },
                    ]);
                },
                onToolResult: (result: ToolResult) => {
                    setAgentEvents((prev) => [
                        ...prev,
                        { type: "tool_result", result },
                    ]);
                },
            });

            try {
                const turnResult = await agentRuntime.run(updated, effectiveModelId);

                setDecision(turnResult.decision);
                setLastOutputChars(turnResult.response.length);
                // Freeze the events from this turn so they render in the correct
                // order (before the assistant response) once the turn is done.
                // Use the functional updater form to capture the current events
                // without relying on the stale closure value of `agentEvents`.
                setCompletedEvents((currentEvents) => currentEvents);
                setMessages([
                    ...updated,
                    {
                        role: "assistant",
                        content: turnResult.response,
                        timestamp: new Date(),
                    },
                ]);
                setAgentEvents([]);
            } catch (error) {
                const errorMsg = error instanceof Error ? error.message : String(error);
                setMessages([
                    ...updated,
                    {
                        role: "assistant",
                        content: `Error: ${errorMsg}`,
                        timestamp: new Date(),
                    },
                ]);
            }

            setStreamedText("");
            setIsStreaming(false);
        }

        submittingRef.current = false;
    }, [messages, isStreaming, effectiveModelId, gateway, noTools, sandbox, toolRegistry]);

    return (
        <Box flexDirection="column" padding={1}>
            {/* Message history — interleave completed tool events before the last assistant response */}
            {messages.map((msg, i) => {
                const isLastAssistant = msg.role === "assistant" && i === messages.length - 1;
                return (
                    <React.Fragment key={i}>
                        {/* Render completed tool events just before the last assistant message */}
                        {isLastAssistant && completedEvents.map((event, ei) => {
                            switch (event.type) {
                                case "tool_call":
                                    return <ToolCallDisplay key={`cte-tc-${ei}`} call={event.call} safety={event.safety} />;
                                case "tool_result":
                                    return <ToolResultDisplay key={`cte-tr-${ei}`} result={event.result} />;
                                default:
                                    return null;
                            }
                        })}
                        <Message
                            message={msg}
                            isLast={i === messages.length - 1}
                            decision={msg.role === "assistant" ? decision : null}
                            outputChars={
                                msg.role === "assistant" && i === messages.length - 1
                                    ? lastOutputChars
                                    : null
                            }
                        />
                    </React.Fragment>
                );
            })}

            {/* Agent events (tool calls, results, permission prompts) */}
            {agentEvents.map((event, i) => {
                switch (event.type) {
                    case "tool_call":
                        return (
                            <ToolCallDisplay
                                key={`tc-${i}`}
                                call={event.call}
                                safety={event.safety}
                            />
                        );
                    case "tool_result":
                        return (
                            <ToolResultDisplay
                                key={`tr-${i}`}
                                result={event.result}
                            />
                        );
                    case "permission_prompt":
                        return (
                            <ToolPermission
                                key={`pp-${i}`}
                                toolName={event.toolName}
                                args={event.args}
                                safety={event.safety}
                                onDecision={event.resolve}
                            />
                        );
                }
            })}

            {/* Streaming in progress */}
            {isStreaming && <StreamingMessage text={streamedText} />}

            {/* Input box */}
            <InputBox
                value={input}
                onChange={setInput}
                onSubmit={handleSubmit}
                modelId={displayModelId}
                tier={decision?.tier}
                isManual={isManual}
                isStreaming={isStreaming}
            />

            {/* Keyboard hints + Status bar */}
            <KeyHints />
            <StatusBar
                modelId={displayModelId}
                isManual={isManual}
                tier={decision?.tier}
            />
        </Box>
    );
}

// Logo is printed ONCE to stdout before Ink mounts.
// This prevents re-render artifacts — Ink never touches these lines.
const LOGO_LINES: readonly [string, string][] = [
    [" ██████╗  █████╗ ███╗   ██╗████████╗██╗  ██╗███████╗ ██████╗ ███╗   ██╗", "#FFD700"],
    [" ██╔══██╗██╔══██╗████╗  ██║╚══██╔══╝██║  ██║██╔════╝██╔═══██╗████╗  ██║", "#F9BD18"],
    [" ██████╔╝███████║██╔██╗ ██║   ██║   ███████║█████╗  ██║   ██║██╔██╗ ██║", "#F5A623"],
    [" ██╔═══╝ ██╔══██║██║╚██╗██║   ██║   ██╔══██║██╔══╝  ██║   ██║██║╚██╗██║", "#E49B20"],
    [" ██║     ██║  ██║██║ ╚████║   ██║   ██║  ██║███████╗╚██████╔╝██║ ╚████║", "#D5911D"],
    [" ╚═╝     ╚═╝  ╚═╝╚═╝  ╚═══╝   ╚═╝   ╚═╝  ╚═╝╚══════╝ ╚═════╝ ╚═╝  ╚═══╝", "#C68A1A"],
];

export function chatCommand(modelId?: string, noTools?: boolean) {
    // Print logo to stdout before Ink takes over — static text
    // that Ink's re-render cycle will never touch
    console.log("");
    for (const [line, color] of LOGO_LINES) {
        console.log(chalk.hex(color)(line));
    }
    console.log(chalk.hex("#6B7280")("                              v0.3.0"));
    console.log("");

    if (noTools) {
        console.log(chalk.hex("#6B7280")("  Tools disabled — running in pure chat mode\n"));
    }

    render(<ChatApp {...(modelId ? { modelId } : {})} noTools={noTools ?? false} />);
}