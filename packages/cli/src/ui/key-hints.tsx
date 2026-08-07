import React from "react";
import { Box, Text } from "ink";
import { theme } from "./theme.js";

export function KeyHints() {
    return (
        <Box justifyContent="center" width="100%" marginTop={1}>
            <Text bold color="white">
                tab
            </Text>
            <Text color={theme.colors.textDim}> models</Text>
            <Text color={theme.colors.textMuted}>{"  "}</Text>
            <Text bold color="white">
                ctrl+c
            </Text>
            <Text color={theme.colors.textDim}> exit</Text>
            <Text color={theme.colors.textMuted}>{"  "}</Text>
            <Text bold color="white">
                enter
            </Text>
            <Text color={theme.colors.textDim}> send</Text>
        </Box>
    );
}
