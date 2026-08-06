import React, { useState, useEffect } from "react";
import { Box, Text, useStdin } from "ink";

interface Props {
    stream: AsyncGenerator<string>;
    onDone: (fullText: string) => void;
}

export function StreamOutput({ stream, onDone }: Props) {
    const [text, setText] = useState("");

    useEffect(() => {
        let accumulated = "";
        const run = async () => {
            for await (const chunk of stream) {
                accumulated += chunk;
                setText(accumulated);
            }
            onDone(accumulated);
        };
        run();
    }, []);

    return (
        <Box flexDirection="column">
            <Text color="cyan">{"assistant › "}</Text>
            <Text>{text}</Text>
        </Box>
    );
}