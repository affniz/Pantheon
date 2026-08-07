import React from "react";
import { Box, Text } from "ink";
import TextInput from "ink-text-input";
import { theme } from "./theme.js";

export interface InputBoxProps {
    value: string;
    onChange: (value: string) => void;
    onSubmit: (value: string) => void;
    modelId: string;
    tier?: string | undefined;
    isManual: boolean;
    isStreaming: boolean;
}

export function InputBox({
    value,
    onChange,
    onSubmit,
    modelId,
    tier,
    isManual,
    isStreaming,
}: InputBoxProps) {
    const borderColor = isStreaming
        ? theme.colors.border
        : theme.colors.borderFocus;
    const modeLabel = isManual ? "manual" : "auto-route";

    return (
        <Box flexDirection="column">
            {/* Bordered input — uses Ink's native borderStyle for
                correct rendering, no manual width calculations */}
            <Box
                borderStyle="single"
                borderColor={borderColor}
                paddingLeft={1}
                paddingRight={1}
            >
                {isStreaming ? (
                    <Text dimColor color={theme.colors.textMuted}>
                        streaming...
                    </Text>
                ) : (
                    <TextInput
                        value={value}
                        onChange={onChange}
                        onSubmit={onSubmit}
                        placeholder="type a message..."
                    />
                )}
            </Box>
            {/* Model context line below the input box */}
            <Box paddingLeft={1}>
                <Text color={theme.colors.textDim}>
                    {`Build ${theme.symbols.bullet} `}
                </Text>
                <Text bold color={theme.colors.accent}>
                    {modelId}
                </Text>
                {tier && (
                    <Text color={theme.colors.textDim}>
                        {` ${theme.symbols.bullet} ${tier}`}
                    </Text>
                )}
                <Text color={theme.colors.textMuted}>{` ${modeLabel}`}</Text>
            </Box>
        </Box>
    );
}
