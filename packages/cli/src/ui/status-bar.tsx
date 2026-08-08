import React from "react";
import { Box, Text } from "ink";
import path from "node:path";
import { theme } from "./theme.js";

export interface StatusBarProps {
  modelId: string;
  isManual: boolean;
  tier?: string | undefined;
}

export function StatusBar({ modelId, isManual, tier }: StatusBarProps) {
  const currentDir = path.basename(process.cwd());

  return (
    <Box justifyContent="space-between" width="100%">
      <Text color={theme.colors.textMuted}>{currentDir}</Text>
      <Text color={theme.colors.textMuted}>v0.3.0</Text>
    </Box>
  );
}
