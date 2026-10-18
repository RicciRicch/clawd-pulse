export type PulseSession = {
  id: string
  title: string
  isRunning: boolean
  lastActivityAt: string
}

export type PulseWindow = { percentUsed: number; resetsAt?: string }

export type PulseData = {
  sessions: PulseSession[]
  hasSessionList?: boolean
  fiveHour?: PulseWindow
  weekly?: PulseWindow
  plan?: string
  updatedAt?: number
}

declare module 'claude-code' {
  interface PluginState {
    'clawd-pulse': { data: PulseData; isBusy: boolean }
  }
}
