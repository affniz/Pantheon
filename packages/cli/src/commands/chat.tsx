import React, { useState, useMemo } from "react";
import { render, Box, useInput } from "ink";
import chalk from "chalk";
import { ModelRegistry, Gateway } from "@pantheon/core";
import type { ChatMessage, RoutingDecision } from "@pantheon/shared";
import { Message, StreamingMessage } from "../ui/message.js";
import { InputBox } from "../ui/input-box.js";
import { KeyHints } from "../ui/key-hints.js";
import { StatusBar } from "../ui/status-bar.js";

interface Props {
    modelId?: string;
}

function ChatApp({ modelId: initialModelId }: Props) {
    const registry = useMemo(() => new ModelRegistry(), []);
    const gateway = useMemo(() => new Gateway(registry), []);

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

    const handleSubmit = async (value: string) => {
        if (!value.trim() || isStreaming) return;

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
    };

    return (
        <Box flexDirection="column" padding={1}>
            {/* Message history */}
            {messages.map((msg, i) => (
                <Message
                    key={i}
                    message={msg}
                    isLast={i === messages.length - 1}
                    decision={msg.role === "assistant" ? decision : null}
                    outputChars={
                        msg.role === "assistant" && i === messages.length - 1
                            ? lastOutputChars
                            : null
                    }
                />
            ))}

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

export function chatCommand(modelId?: string) {
    // Print logo to stdout before Ink takes over — static text
    // that Ink's re-render cycle will never touch
    console.log("");
    for (const [line, color] of LOGO_LINES) {
        console.log(chalk.hex(color)(line));
    }
    console.log(chalk.hex("#6B7280")("                              v0.2.0"));
    console.log("");

    render(<ChatApp {...(modelId ? { modelId } : {})} />);
}