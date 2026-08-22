import React from "react";
import { Text } from "ink";
import { theme } from "./theme.js";

interface PluginBadgeProps {
    /** Plugin name e.g. "@pantheon-plugins/github" */
    pluginName: string;
}

/**
 * Small inline badge displayed next to tool calls that originate from a plugin.
 * Shows the short plugin name (without scope prefix) in a distinctive color.
 */
export function PluginBadge({ pluginName }: PluginBadgeProps) {
    // Shorten @scope/name to just name for display
    const shortName = pluginName.includes("/")
        ? pluginName.split("/").pop() ?? pluginName
        : pluginName;

    return (
        <Text color={theme.colors.accent}>{" 🔌 "}{shortName}</Text>
    );
}
