import React from 'react'
import { Box, Text } from 'ink'
import type { LogLine, LogColor } from '../commands/shared.js'

interface Props {
  logs:    LogLine[]
  height:  number
  columns: number
}

const INK_COLOR: Record<LogColor, string> = {
  white:   'white',
  green:   'green',
  red:     'red',
  yellow:  'yellow',
  cyan:    'cyan',
  magenta: 'magenta',
  dim:     'gray',
}

export function LogPane({ logs, height, columns }: Props) {
  const visible = logs.slice(-Math.max(height, 1))

  // Pad with empty rows so the pane always fills its allocated height
  const padded: (LogLine | null)[] = [...visible]
  while (padded.length < height) padded.unshift(null)

  return (
    <Box
      flexDirection="column"
      width={columns}
      height={height}
      overflow="hidden"
      paddingX={1}
    >
      {padded.map((line, i) => {
        if (!line) return <Text key={`pad-${i}`}> </Text>
        const color = line.color ? INK_COLOR[line.color] : 'white'
        const isDim = line.color === 'dim'
        return (
          <Box key={line.id} flexDirection="row">
            <Text color="gray" dimColor>{line.ts} </Text>
            <Text color={color as Parameters<typeof Text>[0]['color']} dimColor={isDim} wrap="truncate">
              {line.content}
            </Text>
          </Box>
        )
      })}
    </Box>
  )
}
