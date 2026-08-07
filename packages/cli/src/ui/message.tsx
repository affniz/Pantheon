import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import type { ChatMessage, RoutingDecision } from "@pantheon/shared";
import { theme, getTierColor } from "./theme.js";

export interface MessageProps {
  message: ChatMessage;
  isLast: boolean;
  decision?: RoutingDecision | null;
  outputChars?: number | null;
}

export function Message({
  message,
  isLast,
  decision,
  outputChars,
}: MessageProps) {
  if (message.role === "user") {
    return (
      <Box marginBottom={1}>
        <Text bold color={theme.colors.primary}>
          you ›{" "}
        </Text>
        <Text color={theme.colors.text}>{message.content}</Text>
      </Box>
    );
  }

  const tokens = Math.round((outputChars ?? 0) / 4);

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold color={theme.colors.accent}>
        assistant ›
      </Text>
      <Box paddingLeft={2}>
        <Text color={theme.colors.text}>{message.content}</Text>
      </Box>
      {isLast && decision && (
        <Box paddingLeft={2}>
          <Text color={theme.colors.textDim}>
            ↳ routed: {decision.selectedModelId} ·{" "}
            <Text color={getTierColor(decision.tier)}>{decision.tier}</Text>
            {" · ~"}
            {tokens} tokens
          </Text>
        </Box>
      )}
    </Box>
  );
}

export interface StreamingMessageProps {
  text: string;
}

export function StreamingMessage({ text }: StreamingMessageProps) {
  const [showCursor, setShowCursor] = useState(true);

  useEffect(() => {
    const timer = setInterval(() => {
      setShowCursor((prev) => !prev);
    }, 500);
    return () => clearInterval(timer);
  }, []);

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold color={theme.colors.accent}>
        assistant ›
      </Text>
      <Box paddingLeft={2}>
        <Text color={theme.colors.text}>
          {text}
          {showCursor ? " █" : ""}
        </Text>
      </Box>
    </Box>
  );
}
