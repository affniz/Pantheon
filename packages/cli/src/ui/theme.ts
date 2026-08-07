export const theme = {
  colors: {
    // Primary brand — amber/gold
    primary: '#F5A623',
    primaryDim: '#C68A1A',
    // Accent — cyan
    accent: '#56B6C2',
    accentDim: '#3D8A94',
    // Text
    text: '#E0E0E0',
    textDim: '#6B7280',
    textMuted: '#4B5563',
    // Backgrounds / borders
    border: '#3A3A3A',
    borderFocus: '#5A5A5A',
    // Semantic
    success: '#4ADE80',
    warning: '#FBBF24',
    error: '#EF4444',
    // Routing tiers
    tierSimple: '#4ADE80',
    tierStandard: '#60A5FA',
    tierComplex: '#F472B6',
  },
  symbols: {
    brand: '◆',
    prompt: '›',
    arrow: '→',
    bullet: '•',
    check: '✓',
    cross: '✗',
    dot: '●',
    dash: '─',
    ellipsis: '…',
  },
  border: {
    topLeft: '┌',
    topRight: '┐',
    bottomLeft: '└',
    bottomRight: '┘',
    horizontal: '─',
    vertical: '│',
  },
} as const;

export type Theme = typeof theme;

// Helper to get tier color
export function getTierColor(tier: string): string {
  switch (tier) {
    case 'simple': return theme.colors.tierSimple;
    case 'standard': return theme.colors.tierStandard;
    case 'complex': return theme.colors.tierComplex;
    default: return theme.colors.textDim;
  }
}
