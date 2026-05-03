import React from 'react'
import { Box, Text } from 'ink'

interface Props {
  role:      'seller' | 'buyer'
  model:     string
  provider:  'ollama' | 'openai'
  agentId:   string | null
  wallet:    string | null
  phase:     'connecting' | 'ready' | 'error'
  columns:   number
}

const ROLE_COLOR = { seller: 'magenta', buyer: 'cyan' } as const
const PHASE_LABEL = {
  connecting: { text: '● connecting', color: 'yellow'  },
  ready:      { text: '● ready',      color: 'green'   },
  error:      { text: '● error',      color: 'red'     },
} as const

export function Header({ role, model, provider, agentId, wallet, phase, columns }: Props) {
  const roleColor  = ROLE_COLOR[role]
  const phaseInfo  = PHASE_LABEL[phase]
  const shortAgent = agentId ? agentId.slice(0, 8) + '…' : '—'
  const shortWallet = wallet
    ? wallet.slice(0, 6) + '…' + wallet.slice(-4)
    : '—'

  return (
    <Box flexDirection="column" width={columns}>
      {/* Top line */}
      <Box borderStyle="round" borderColor={roleColor} paddingX={1}>
        <Text bold color={roleColor}>PHANTOM ✦ </Text>
        <Text bold color={roleColor}>{role.toUpperCase()}</Text>
        <Text color="dim">  │  </Text>
        <Text color={provider === 'ollama' ? 'green' : 'blue'}>{model}</Text>
        <Text color="dim">  │  </Text>
        <Text color="dim">agent: </Text>
        <Text>{shortAgent}</Text>
        <Text color="dim">  │  wallet: </Text>
        <Text color="dim">{shortWallet}</Text>
        <Text color="dim">  │  </Text>
        <Text color={phaseInfo.color}>{phaseInfo.text}</Text>
      </Box>
    </Box>
  )
}
