import React, { useState, useMemo, useRef, useCallback, useEffect } from "react";
import { render, Box, useInput } from "ink";
import chalk from "chalk";
import { ensureServerRunning, getServerUrl } from "../server-manager.js";
import { PantheonApiClient } from "../api-client.js";
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
    | { type: "permission_prompt"; toolCallId: string; toolName: string; args: Record<string, unknown>; safety: "safe" | "destructive"; resolve: (decision: PermissionDecision) => void };

interface Props {
    modelId?: string;
    noTools?: boolean | undefined;
    resume?: string | boolean | undefined;
    noSave?: boolean | undefined;
}

function ChatApp({ modelId: initialModelId, noTools = false, resume, noSave }: Props) {
    const client = useMemo(() => new PantheonApiClient(getServerUrl()), []);

    // Session state
    const [sessionId, setSessionId] = useState<string | null>(null);
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [isInitializing, setIsInitializing] = useState(true);

    // Model selector (kept client-side for display only — routing happens server-side)
    const [modelOptions, setModelOptions] = useState<string[]>(["auto"]);
    const [selectedIndex, setSelectedIndex] = useState(0);

    const [input, setInput] = useState("");
    const [isStreaming, setIsStreaming] = useState(false);
    const [streamedText, setStreamedText] = useState("");
    const [decision, setDecision] = useState<RoutingDecision | null>(null);
    const [lastOutputChars, setLastOutputChars] = useState<number | null>(null);
    const [agentEvents, setAgentEvents] = useState<AgentEvent[]>([]);
    const [completedEvents, setCompletedEvents] = useState<AgentEvent[]>([]);

    const submittingRef = useRef(false);

    // Fetch models and initialize session on mount
    useEffect(() => {
        (async () => {
            try {
                // Load model list from API
                const { models, defaultModel } = await client.listModels();
                const ids = models.map((m) => m.id);
                setModelOptions(["auto", ...ids]);

                if (initialModelId) {
                    const idx = ["auto", ...ids].indexOf(initialModelId);
                    if (idx >= 0) setSelectedIndex(idx);
                }

                // Resolve session
                if (!noSave) {
                    if (resume) {
                        const targetId = typeof resume === "string" ? resume : undefined;
                        if (targetId) {
                            try {
                                const session = await client.getSession(targetId);
                                setSessionId(session.id);
                                const msgs = await client.getSessionMessages(session.id);
                                setMessages(msgs);
                            } catch {
                                // Session not found — start fresh
                                setSessionId(null);
                            }
                        } else {
                            // --resume with no id — get latest from list
                            const sessions = await client.listSessions({ limit: 1 });
                            if (sessions[0]) {
                                const session = sessions[0];
                                setSessionId(session.id);
                                const msgs = await client.getSessionMessages(session.id);
                                setMessages(msgs);
                            }
                        }
                    }
                    // Session ID will be assigned by the server on first chat call
                }
            } catch (err) {
                // Server not reachable — we'll get an error when submitting
            } finally {
                setIsInitializing(false);
            }
        })();
    }, []);

    const currentOption = modelOptions[selectedIndex] ?? "auto";
    const effectiveModelId = currentOption === "auto" ? undefined : currentOption;
    const isManual = currentOption !== "auto";
    const displayModelId = currentOption;

    useInput((ch, key) => {
        if (key.ctrl && ch.toLowerCase() === "c") process.exit(0);
        if (key.tab && !isStreaming) {
            setSelectedIndex((prev) => (prev + 1) % modelOptions.length);
        }
    });

    const handleSubmit = useCallback(async (value: string) => {
        if (!value.trim() || isStreaming || submittingRef.current || isInitializing) return;
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

        try {
            let accumulatedText = "";
            let finalSessionId = sessionId;
            let iterations = 1;

            const stream = client.chat({
                ...((!noSave && sessionId) ? { sessionId } : {}),
                prompt: value.trim(),
                ...(effectiveModelId ? { model: effectiveModelId } : {}),
                ...((noTools) ? { noTools: true } : {}),
                workingDir: process.cwd(),
            });

            for await (const evt of stream) {
                switch (evt.event) {
                    case "routing":
                        setDecision(evt.data as RoutingDecision);
                        break;

                    case "text":
                        accumulatedText += evt.data.content;
                        setStreamedText(accumulatedText);
                        break;

                    case "tool_call": {
                        const d = evt.data;
                        const call: ToolCall = { id: d.id, name: d.name, arguments: d.arguments };
                        setAgentEvents((prev) => [...prev, { type: "tool_call", call, safety: d.safety }]);
                        break;
                    }

                    case "tool_permission_required": {
                        const d = evt.data;
                        // Render permission prompt in TUI, resolve on user input
                        await new Promise<void>((outerResolve) => {
                            setAgentEvents((prev) => [
                                ...prev,
                                {
                                    type: "permission_prompt",
                                    toolCallId: d.toolCallId,
                                    toolName: d.toolName,
                                    args: d.args,
                                    safety: d.safety,
                                    resolve: async (decision: PermissionDecision) => {
                                        await client.respondToToolPermission(d.toolCallId, decision);
                                        outerResolve();
                                    },
                                },
                            ]);
                        });
                        break;
                    }

                    case "tool_result": {
                        const d = evt.data;
                        const result: ToolResult = {
                            toolCallId: d.toolCallId,
                            name: "",
                            content: d.content,
                            isError: d.isError,
                        };
                        setAgentEvents((prev) => [...prev, { type: "tool_result", result }]);
                        break;
                    }

                    case "done":
                        finalSessionId = evt.data.sessionId;
                        iterations = evt.data.iterations;
                        break;

                    case "error":
                        accumulatedText = `Error: ${evt.data.message}`;
                        setStreamedText(accumulatedText);
                        break;

                    // ── v0.6 orchestration events ────────────────────────────
                    case "orchestration_start": {
                        const d = evt.data;
                        const prefix = `\n⚙  Orchestrating with ${d.taskCount} parallel tasks (plan: ${d.planId.slice(0, 8)})\n`;
                        accumulatedText += prefix;
                        setStreamedText(accumulatedText);
                        break;
                    }

                    case "plan_created": {
                        const plan = evt.data.plan as { tasks?: Array<{ id: string; title: string }> };
                        if (plan?.tasks) {
                            const taskList = plan.tasks
                                .map((t: { id: string; title: string }, i: number) => `  ${i + 1}. ${t.title}`)
                                .join("\n");
                            accumulatedText += `\n📋 Task Plan:\n${taskList}\n`;
                            setStreamedText(accumulatedText);
                        }
                        break;
                    }

                    case "agent_spawned": {
                        const agent = evt.data.agent as { taskId?: string };
                        if (agent?.taskId) {
                            accumulatedText += `\n  ▶ [executor] started task ${agent.taskId}`;
                            setStreamedText(accumulatedText);
                        }
                        break;
                    }

                    case "agent_completed": {
                        const d = evt.data;
                        accumulatedText += `\n  ✓ [executor:${d.agentId.slice(0, 6)}] completed`;
                        setStreamedText(accumulatedText);
                        break;
                    }

                    case "agent_failed": {
                        const d = evt.data;
                        accumulatedText += `\n  ✗ [executor:${d.agentId.slice(0, 6)}] failed: ${d.error}`;
                        setStreamedText(accumulatedText);
                        break;
                    }

                    case "review_result": {
                        const d = evt.data;
                        const icon = d.approved ? "✅" : "⚠️";
                        accumulatedText += `\n\n${icon} Review: ${d.feedback}\n\n`;
                        setStreamedText(accumulatedText);
                        break;
                    }

                    case "orchestration_done":
                        // Final response arrives via the "text" event — nothing extra needed here
                        break;
                }
            }

            // Update session id from server response
            if (finalSessionId && !noSave) setSessionId(finalSessionId);

            const assistantMsg: ChatMessage = {
                role: "assistant",
                content: accumulatedText,
                timestamp: new Date(),
            };

            setLastOutputChars(accumulatedText.length);
            setCompletedEvents((current) => current);
            setMessages([...updated, assistantMsg]);
            setAgentEvents([]);

        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            setMessages([
                ...updated,
                { role: "assistant", content: `Error: ${errorMsg}`, timestamp: new Date() },
            ]);
        }

        setStreamedText("");
        setIsStreaming(false);
        submittingRef.current = false;
    }, [messages, isStreaming, effectiveModelId, client, noTools, sessionId, noSave, isInitializing]);

    return (
        <Box flexDirection="column" padding={1}>
            {/* Message history */}
            {messages.map((msg, i) => {
                const isLastAssistant = msg.role === "assistant" && i === messages.length - 1;
                return (
                    <React.Fragment key={i}>
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

            {/* Live agent events */}
            {agentEvents.map((event, i) => {
                switch (event.type) {
                    case "tool_call":
                        return <ToolCallDisplay key={`tc-${i}`} call={event.call} safety={event.safety} />;
                    case "tool_result":
                        return <ToolResultDisplay key={`tr-${i}`} result={event.result} />;
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

            {isStreaming && <StreamingMessage text={streamedText} />}

            <InputBox
                value={input}
                onChange={setInput}
                onSubmit={handleSubmit}
                modelId={displayModelId}
                tier={decision?.tier}
                isManual={isManual}
                isStreaming={isStreaming}
            />

            <KeyHints />
            <StatusBar
                modelId={displayModelId}
                isManual={isManual}
                tier={decision?.tier}
            />
        </Box>
    );
}

// Logo printed once before Ink mounts
const LOGO_LINES: readonly [string, string][] = [
    [" ██████╗  █████╗ ███╗   ██╗████████╗██╗  ██╗███████╗ ██████╗ ███╗   ██╗", "#FFD700"],
    [" ██╔══██╗██╔══██╗████╗  ██║╚══██╔══╝██║  ██║██╔════╝██╔═══██╗████╗  ██║", "#F9BD18"],
    [" ██████╔╝███████║██╔██╗ ██║   ██║   ███████║█████╗  ██║   ██║██╔██╗ ██║", "#F5A623"],
    [" ██╔═══╝ ██╔══██║██║╚██╗██║   ██║   ██╔══██║██╔══╝  ██║   ██║██║╚██╗██║", "#E49B20"],
    [" ██║     ██║  ██║██║ ╚████║   ██║   ██║  ██║███████╗╚██████╔╝██║ ╚████║", "#D5911D"],
    [" ╚═╝     ╚═╝  ╚═╝╚═╝  ╚═══╝   ╚═╝   ╚═╝  ╚═╝╚══════╝ ╚═════╝ ╚═╝  ╚═══╝", "#C68A1A"],
];

export async function chatCommand(modelId?: string, noTools?: boolean, resume?: string | boolean, noSave?: boolean) {
    // Auto-start the server if not running
    try {
        await ensureServerRunning();
    } catch (err) {
        console.error(chalk.red(`\n  ✗ Cannot start Pantheon server: ${err instanceof Error ? err.message : String(err)}`));
        console.error(chalk.hex("#6B7280")("  Run `pnpm turbo build` to build the server, then try again.\n"));
        process.exit(1);
    }

    console.log("");
    for (const [line, color] of LOGO_LINES) {
        console.log(chalk.hex(color)(line));
    }
    console.log(chalk.hex("#6B7280")("                              v0.6.0"));
    console.log("");

    if (resume) {
        console.log(chalk.hex("#56B6C2")(`  Resuming session...\n`));
    }

    if (noTools) {
        console.log(chalk.hex("#6B7280")("  Tools disabled — running in pure chat mode\n"));
    }

    render(
        <ChatApp
            {...(modelId ? { modelId } : {})}
            noTools={noTools ?? false}
            resume={resume}
            noSave={noSave}
        />
    );
}