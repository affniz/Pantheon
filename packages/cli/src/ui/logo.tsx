import React from 'react';
import { Box, Text } from 'ink';
import { theme } from './theme.js';

const LOGO_LINES = [
  ' ██████╗  █████╗ ███╗   ██╗████████╗██╗  ██╗███████╗ ██████╗ ███╗   ██╗',
  ' ██╔══██╗██╔══██╗████╗  ██║╚══██╔══╝██║  ██║██╔════╝██╔═══██╗████╗  ██║',
  ' ██████╔╝███████║██╔██╗ ██║   ██║   ███████║█████╗  ██║   ██║██╔██╗ ██║',
  ' ██╔═══╝ ██╔══██║██║╚██╗██║   ██║   ██╔══██║██╔══╝  ██║   ██║██║╚██╗██║',
  ' ██║     ██║  ██║██║ ╚████║   ██║   ██║  ██║███████╗╚██████╔╝██║ ╚████║',
  ' ╚═╝     ╚═╝  ╚═╝╚═╝  ╚═══╝   ╚═╝   ╚═╝  ╚═╝╚══════╝ ╚═════╝ ╚═╝  ╚═══╝',
];

const GRADIENT_COLORS = [
  '#FFD700',
  '#F9BD18',
  '#F5A623',
  '#E49B20',
  '#D5911D',
  '#C68A1A',
];

export function Logo() {
  return (
    <Box marginBottom={1} flexDirection="column" alignItems="center">
      {LOGO_LINES.map((line, index) => (
        <Text key={index} color={GRADIENT_COLORS[index]!}>
          {line}
        </Text>
      ))}
      <Text color={theme.colors.textDim}>v0.4.0</Text>
    </Box>
  );
}
