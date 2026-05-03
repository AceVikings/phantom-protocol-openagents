import React from 'react'
import { Box, Text } from 'ink'

interface Props {
  value:   string
  busy:    boolean
  spinner: string
  columns: number
  role:    'seller' | 'buyer'
}

export function InputBar({ value, busy, spinner, columns, role }: Props) {
  const color    = role === 'seller' ? 'magenta' : 'cyan'
  const prompt   = `${role === 'seller' ? '✦' : '◆'} `
  const cursor   = busy ? '' : '█'

  return (
    <Box
      borderStyle="round"
      borderColor={color}
      paddingX={1}
      width={columns}
    >
      {busy
        ? <Text color="yellow">{spinner} </Text>
        : <Text color={color} bold>{prompt}</Text>
      }
      <Text wrap="truncate">{value}{cursor}</Text>
    </Box>
  )
}
