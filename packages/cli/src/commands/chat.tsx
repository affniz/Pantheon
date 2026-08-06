import React, { useState } from "react";
import { render, Box, Text, useInput, useStdin } from "ink";
import TextInput from "ink-text-input";
import { ModelRegistry, Gateway } from "@pantheon/core";
import type { ChatMessage } from "@pantheon/shared";

interface Props {
    modelId?: string;
}

function ChatApp({ modelId }: Props) {
    const registry = new ModelRegistry();
    const gateway = new Gateway(registry);

    const model = modelId ? registry.get(modelId) : registry.getDefault();
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [input, setInput] = useState("");
    const [isStreaming, setIsStreaming] = useState(false);
    const [streamedText, setStreamedText] = useState("");

    useInput((_, key) => {
        if (key.ctrl && _.toLowerCase() === "c") process.exit(0);
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

        let accumulated = "";
        for await (const chunk of gateway.stream(updated, model?.id)) {
            accumulated += chunk;
            setStreamedText(accumulated);
        }

        setMessages([
            ...updated,
            { role: "assistant", content: accumulated, timestamp: new Date() },
        ]);
        setStreamedText("");
        setIsStreaming(false);
    };

    return (
        <Box flexDirection="column" padding={1}>
            <Box marginBottom={1}>
                <Text bold color="magenta">
                    ◆ Pantheon
                </Text>
                <Text color="gray"> using </Text>
                <Text color="cyan">{model?.displayName ?? model?.id ?? "no model"}</Text>
                <Text color="gray"> · ctrl+c to exit</Text>
            </Box>

            {messages.map((msg, i) => (
                <Box key={i} flexDirection="column" marginBottom={1}>
                    <Text color={msg.role === "user" ? "yellow" : "cyan"}>
                        {msg.role === "user" ? "you › " : "assistant › "}
                    </Text>
                    <Text>{msg.content}</Text>
                </Box>
            ))}

            {isStreaming && (
                <Box flexDirection="column" marginBottom={1}>
                    <Text color="cyan">{"assistant › "}</Text>
                    <Text>{streamedText}</Text>
                </Box>
            )}

            <Box>
                <Text color="yellow">{"you › "}</Text>
                <TextInput
                    value={input}
                    onChange={setInput}
                    onSubmit={handleSubmit}
                    placeholder="type a message..."
                />
            </Box>
        </Box>
    );
}

export function chatCommand(modelId?: string) {
    render(<ChatApp {...(modelId ? { modelId } : {})} />);
}