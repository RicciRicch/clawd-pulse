import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionRateLimit } from 'claude-code'

import type { PulseData, PulseSession, PulseWindow } from '../types'

const PANE = 'clawd-pulse'
const TITLE = 'Clawd Pulse'
const SERVER = 'ccd_session_mgmt'
const POLL_MS = 30_000

const data = atom({ plugin: 'clawd-pulse', key: 'data' } as const, { sessions: [] } as PulseData)
const isBusy = atom({ plugin: 'clawd-pulse', key: 'isBusy' } as const, false)

type Mood = 'happy' | 'working' | 'tired' | 'sleeping'
type Row = { id: string; title: string; isWorking: boolean; lastActivityAt?: string }

// ---------- data ----------

function textOf(result: { content: { text?: string }[] }): string {
  return result.content.map(block => block.text ?? '').join('')
}

async function fetchSessions($: EngineInterface): Promise<PulseSession[] | undefined> {
  try {
    const result = await $.mcp.call(SERVER, 'list_sessions', { limit: 30 })
    if (result.isError) return undefined
    const rows = JSON.parse(textOf(result)) as {
      sessionId: string
      title?: string
      isRunning?: boolean
      lastActivityAt?: string
    }[]
    return rows.map(row => ({
      id: row.sessionId,
      title: row.title || 'Untitled session',
      isRunning: row.isRunning === true,
      lastActivityAt: row.lastActivityAt ?? '',
    }))
  } catch {
    return undefined
  }
}

async function fetchPlan($: EngineInterface): Promise<{ plan?: string; fiveHour?: PulseWindow; weekly?: PulseWindow }> {
  try {
    const result = await $.mcp.call(SERVER, 'get_usage', {})
    if (result.isError) return {}
    const usage = JSON.parse(textOf(result)) as {
      plan?: { status?: string; plan?: string; windows?: { label: string; percentUsed: number; resetsAt?: string }[] }
    }
    const windows = usage.plan?.windows ?? []
    const pick = (test: (label: string) => boolean): PulseWindow | undefined => {
      const found = windows.find(w => test(w.label.toLowerCase()))
      return found && { percentUsed: found.percentUsed, resetsAt: found.resetsAt }
    }
    return {
      plan: usage.plan?.plan,
      fiveHour: pick(label => label.startsWith('5-hour')),
      weekly: pick(label => label.includes('all models')) ?? pick(label => label.startsWith('weekly')),
    }
  } catch {
    return {}
  }
}

function fromLimit(limits: SessionRateLimit[], kind: string): PulseWindow | undefined {
  const found = limits.find(limit => limit.kind === kind)
  return found && { percentUsed: found.percentUsed, resetsAt: found.resetsAt }
}

async function refresh($: EngineInterface): Promise<void> {
  const [sessions, plan] = await Promise.all([fetchSessions($), fetchPlan($)])
  let { fiveHour, weekly } = plan
  if (!fiveHour || !weekly) {
    const { rateLimits } = await $.session.usage()
    fiveHour ??= fromLimit(rateLimits, 'five_hour')
    weekly ??= fromLimit(rateLimits, 'seven_day')
  }
  const updatedAt = await $.clock.now()
  await update($, data, () => ({
    sessions: sessions ?? [],
    hasSessionList: sessions !== undefined,
    fiveHour,
    weekly,
    plan: plan.plan,
    updatedAt,
  }))
}

// ---------- derived ----------

function rowsOf(d: PulseData, busy: boolean): Row[] {
  const others = [...d.sessions]
    .sort((a, b) => Number(b.isRunning) - Number(a.isRunning) || b.lastActivityAt.localeCompare(a.lastActivityAt))
    .map(s => ({ id: s.id, title: s.title, isWorking: s.isRunning, lastActivityAt: s.lastActivityAt }))
  return [{ id: 'self', title: 'This session', isWorking: busy }, ...others].slice(0, 8)
}

function peakOf(d: PulseData): number {
  return Math.max(d.fiveHour?.percentUsed ?? 0, d.weekly?.percentUsed ?? 0)
}

function moodOf(d: PulseData, working: number): Mood {
  const peak = peakOf(d)
  if (peak >= 95) return 'sleeping'
  if (peak >= 80) return 'tired'
  if (working > 0) return 'working'
  return 'happy'
}

function until(iso: string | undefined, now: number): string {
  if (!iso) return '—'
  const ms = Date.parse(iso) - now
  if (!Number.isFinite(ms) || ms <= 0) return 'now'
  const mins = Math.round(ms / 60_000)
  const days = Math.floor(mins / 1440)
  const hours = Math.floor((mins % 1440) / 60)
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${mins % 60}m`
  return `${mins}m`
}

function ago(iso: string | undefined, now: number): string {
  if (!iso) return ''
  const mins = Math.round((now - Date.parse(iso)) / 60_000)
  if (!Number.isFinite(mins)) return ''
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`
  return `${Math.round(mins / 1440)}d ago`
}

function speech(mood: Mood, d: PulseData, working: number, now: number): string {
  const hot = (d.fiveHour?.percentUsed ?? 0) >= (d.weekly?.percentUsed ?? 0) ? d.fiveHour : d.weekly
  switch (mood) {
    case 'sleeping':
      return `Out of juice. Napping until reset in ${until(hot?.resetsAt, now)}… zzz`
    case 'tired':
      return `Running low (${Math.round(peakOf(d))}%). Pace yourself — reset in ${until(hot?.resetsAt, now)}.`
    case 'working':
      return working === 1 ? 'Busy crunching on 1 session!' : `Juggling ${working} sessions at once!`
    case 'happy':
      return d.fiveHour || d.weekly ? 'Fully charged. What are we building?' : 'Hi! Waiting for my first usage reading…'
  }
}

function levelColor(pct: number): string {
  if (pct >= 80) return '#E8634F'
  if (pct >= 50) return '#E9A94F'
  return '#6CC08B'
}

// ---------- the mascot and gauges, as SVG ----------

const ORANGE = '#D97757'
const GLOW: Record<Mood, string> = { happy: ORANGE, working: '#E9A94F', tired: '#E8634F', sleeping: '#7C8BE6' }

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function clawd(mood: Mood): string {
  const body = mood === 'tired' ? '#C98466' : mood === 'sleeping' ? '#B9826B' : ORANGE
  const bob: Record<Mood, string> = {
    happy: '<animateTransform attributeName="transform" type="translate" values="0 0;0 -7;0 0" dur="1.4s" repeatCount="indefinite"/>',
    working: '<animateTransform attributeName="transform" type="translate" values="0 0;0 -3;0 0" dur="0.45s" repeatCount="indefinite"/>',
    tired: '<animateTransform attributeName="transform" type="translate" values="0 0;-2 1;0 0;2 1;0 0" dur="3s" repeatCount="indefinite"/>',
    sleeping: '<animateTransform attributeName="transform" type="translate" values="0 0;0 2;0 0" dur="3.2s" repeatCount="indefinite"/>',
  }
  const eye = (x: number): string => {
    if (mood === 'sleeping') return `<rect x="${x - 2}" y="24" width="12" height="3" fill="#1b1512"/>`
    if (mood === 'tired') return `<rect x="${x}" y="20" width="8" height="7" fill="#1b1512"/>`
    const dx = mood === 'working' ? 4 : 0
    return `<rect x="${x + dx}" y="12" width="8" height="16" fill="#1b1512">
      <animate attributeName="height" values="16;16;2;16" keyTimes="0;0.92;0.96;1" dur="3.6s" repeatCount="indefinite"/>
      <animate attributeName="y" values="12;12;19;12" keyTimes="0;0.92;0.96;1" dur="3.6s" repeatCount="indefinite"/>
    </rect>`
  }
  const arm = (x: number, delay: string): string =>
    mood === 'working'
      ? `<rect x="${x}" y="20" width="10" height="15" fill="${body}"><animate attributeName="y" values="20;12;20" dur="0.36s" begin="${delay}" repeatCount="indefinite"/></rect>`
      : `<rect x="${x}" y="20" width="10" height="15" fill="${body}"/>`
  const extras =
    mood === 'sleeping'
      ? [0, 1.1, 2.2]
          .map(
            begin => `<text x="96" y="0" fill="#AEB8F5" font-size="13" font-weight="700" opacity="0">z
      <animate attributeName="y" values="4;-30" dur="3.3s" begin="${begin}s" repeatCount="indefinite"/>
      <animate attributeName="x" values="92;110" dur="3.3s" begin="${begin}s" repeatCount="indefinite"/>
      <animate attributeName="opacity" values="0;1;0" dur="3.3s" begin="${begin}s" repeatCount="indefinite"/></text>`,
          )
          .join('')
      : mood === 'tired'
        ? `<path d="M92 4 q4 7 0 10 q-4 -3 0 -10z" fill="#8FC7F2">
      <animateTransform attributeName="transform" type="translate" values="0 0;0 18" dur="1.8s" repeatCount="indefinite"/>
      <animate attributeName="opacity" values="1;0" dur="1.8s" repeatCount="indefinite"/></path>`
        : mood === 'working'
          ? `<text x="96" y="0" fill="#F4C27A" font-size="12">✦<animate attributeName="opacity" values="0;1;0" dur="0.9s" repeatCount="indefinite"/></text>`
          : ''
  return `<g transform="translate(38 76)"><g>${bob[mood]}
    ${arm(0, '0s')}${arm(90, '0.18s')}
    <rect x="10" y="0" width="80" height="50" fill="${body}"/>
    ${[18, 32, 60, 74].map(x => `<rect x="${x}" y="50" width="8" height="14" fill="${body}"/>`).join('')}
    ${eye(28)}${eye(64)}
    ${extras}
  </g></g>`
}

function gauge(cx: number, cy: number, label: string, w: PulseWindow | undefined, now: number): string {
  const r = 36
  const circ = 2 * Math.PI * r
  const pct = Math.min(100, Math.max(0, w?.percentUsed ?? 0))
  const len = (pct / 100) * circ
  const color = levelColor(pct)
  return `<g>
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#ffffff14" stroke-width="9"/>
    ${w ? `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color}" stroke-width="9" stroke-linecap="round" stroke-dasharray="${len.toFixed(1)} ${circ.toFixed(1)}" transform="rotate(-90 ${cx} ${cy})"/>` : ''}
    <text x="${cx}" y="${cy + 7}" text-anchor="middle" fill="#F5ECE4" font-size="20" font-weight="700">${w ? `${Math.round(pct)}%` : '—'}</text>
    <text x="${cx}" y="${cy + 58}" text-anchor="middle" fill="#B3A499" font-size="10" letter-spacing="2">${label}</text>
    <text x="${cx}" y="${cy + 74}" text-anchor="middle" fill="#7F726A" font-size="10">${w ? `resets in ${esc(until(w.resetsAt, now))}` : 'no reading yet'}</text>
  </g>`
}

function dashboardSvg(d: PulseData, mood: Mood, working: number, line: string, now: number): string {
  const glow = GLOW[mood]
  const flow = mood === 'sleeping' ? '' : `<animate attributeName="stroke-dashoffset" values="20;0" dur="${mood === 'working' ? '0.5s' : mood === 'tired' ? '2.4s' : '1.2s'}" repeatCount="indefinite"/>`
  const plan = d.plan ? esc(d.plan.toUpperCase()) : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 440 214" width="440" height="214" font-family="ui-monospace, SFMono-Regular, Consolas, Menlo, monospace">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#241E1A"/><stop offset="1" stop-color="#14110F"/></linearGradient>
    <radialGradient id="glow"><stop offset="0" stop-color="${glow}" stop-opacity="0.35"/><stop offset="1" stop-color="${glow}" stop-opacity="0"/></radialGradient>
  </defs>
  <rect width="440" height="214" rx="18" fill="url(#bg)"/>
  <rect x="0.5" y="0.5" width="439" height="213" rx="17.5" fill="none" stroke="#ffffff12"/>
  <circle cx="88" cy="110" r="78" fill="url(#glow)"/>
  <text x="20" y="30" fill="#F5ECE4" font-size="12" font-weight="700" letter-spacing="3">CLAWD PULSE</text>
  <circle cx="24" cy="48" r="4" fill="${working > 0 ? '#6CC08B' : '#5E544E'}">${working > 0 ? '<animate attributeName="opacity" values="1;0.3;1" dur="1.2s" repeatCount="indefinite"/>' : ''}</circle>
  <text x="34" y="52" fill="#B3A499" font-size="11">${working} working</text>
  ${plan ? `<rect x="${420 - plan.length * 8 - 16}" y="16" width="${plan.length * 8 + 16}" height="20" rx="10" fill="${ORANGE}" fill-opacity="0.18"/><text x="${420 - (plan.length * 8 + 16) / 2}" y="30" text-anchor="middle" fill="${ORANGE}" font-size="11" font-weight="700" letter-spacing="1">${plan}</text>` : ''}
  <path d="M140 104 C 168 104, 178 96, 210 96" fill="none" stroke="${glow}" stroke-width="3" stroke-linecap="round" stroke-dasharray="3 7" opacity="${mood === 'sleeping' ? 0.35 : 0.9}">${flow}</path>
  <circle cx="212" cy="96" r="4" fill="${glow}"/>
  ${clawd(mood)}
  ${gauge(262, 96, '5-HOUR', d.fiveHour, now)}
  ${gauge(370, 96, 'WEEKLY', d.weekly, now)}
  <text x="20" y="198" fill="${ORANGE}" font-size="12">› ${esc(line)}</text>
</svg>`
}

// ---------- terminal bits ----------

function bar(pct: number, cells = 14): string {
  const filled = Math.round((Math.min(100, Math.max(0, pct)) / 100) * cells)
  return '█'.repeat(filled) + '░'.repeat(cells - filled)
}

function termColor(pct: number): string {
  if (pct >= 80) return 'error'
  if (pct >= 50) return 'warning'
  return 'success'
}

// ---------- hooks ----------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'pulse', description: 'Open the Clawd Pulse dashboard' })
    void $.ui.open({ id: PANE, title: TITLE })
    void refresh($).catch(() => undefined)
    $.clock.every(POLL_MS, () => void refresh($).catch(() => undefined))

    return next(e)
  })

  on('command.run', { command: 'pulse' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })
    void refresh($).catch(() => undefined)

    return { text: 'Clawd Pulse opened.' }
  })

  on('turn.start', async ($, e, next) => {
    await update($, isBusy, () => true)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    await update($, isBusy, () => false)
    void refresh($).catch(() => undefined)
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits')) {
      const fiveHour = fromLimit(e.rateLimits, 'five_hour')
      const weekly = fromLimit(e.rateLimits, 'seven_day')
      await update($, data, d => ({ ...d, fiveHour: fiveHour ?? d.fiveHour, weekly: weekly ?? d.weekly }))
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const d = await read($, data)
    const busy = await read($, isBusy)
    const now = await $.clock.now()
    const rows = rowsOf(d, busy)
    const working = rows.filter(row => row.isWorking).length
    const mood = moodOf(d, working)
    const line = speech(mood, d, working, now)
    const updated = d.updatedAt ? `updated ${ago(new Date(d.updatedAt).toISOString(), now)}` : 'loading…'

    if (e.surface === 'terminal') {
      const { Box, Text, Button } = $.ui.resolve(e)
      const eyes = mood === 'tired' || mood === 'sleeping' ? ' ▐▄███▄▌' : ' ▐▛███▜▌'
      const limit = (label: string, w: PulseWindow | undefined) => (
        <Box flexDirection="row" gap={1}>
          <Text bold>{label}</Text>
          <Text color={termColor(w?.percentUsed ?? 0)}>{bar(w?.percentUsed ?? 0)}</Text>
          <Text bold>{w ? `${Math.round(w.percentUsed)}%`.padStart(4) : '  —'}</Text>
          <Text dimColor>{w ? `resets ${until(w.resetsAt, now)}` : 'no reading'}</Text>
        </Box>
      )
      return (
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="row" gap={2}>
            <Box flexDirection="column">
              <Text color="claude">{eyes}{mood === 'sleeping' ? ' z' : ''}</Text>
              <Text color="claude">▝▜█████▛▘</Text>
              <Text color="claude">{'  ▘▘ ▝▝'}</Text>
            </Box>
            <Box flexDirection="column">
              {limit('5h', d.fiveHour)}
              {limit('wk', d.weekly)}
              <Text color="claude" wrap="truncate">› {line}</Text>
            </Box>
          </Box>
          <Box flexDirection="column">
            <Text bold>SESSIONS · {working} working</Text>
            {rows.map(row => (
              <Box flexDirection="row" justifyContent="space-between" gap={1}>
                <Box flexDirection="row" gap={1} flexShrink={1}>
                  <Text color={row.isWorking ? 'success' : 'inactive'}>{row.isWorking ? '●' : '○'}</Text>
                  <Text bold={row.isWorking} wrap="truncate">{row.title}</Text>
                </Box>
                <Text dimColor>{row.isWorking ? 'working' : ago(row.lastActivityAt, now)}</Text>
              </Box>
            ))}
            {d.hasSessionList === false && <Text dimColor>Other sessions show up in the Claude desktop app.</Text>}
          </Box>
          <Box flexDirection="row" gap={2}>
            <Button key="refresh" label="Refresh" hotkey="r" onPress={() => void refresh($).catch(() => undefined)} />
            <Text dimColor>{updated}</Text>
          </Box>
        </Box>
      )
    }

    const { Box, Text, Button, Svg } = $.ui.resolve(e)
    return (
      <Box flexDirection="column" gap={1}>
        <Svg
          source={dashboardSvg(d, mood, working, line, now)}
          alt={`Clawd is ${mood}. 5-hour limit ${d.fiveHour ? Math.round(d.fiveHour.percentUsed) + '%' : 'unknown'}, weekly ${d.weekly ? Math.round(d.weekly.percentUsed) + '%' : 'unknown'}. ${line}`}
          isInteractive
        />
        <Box flexDirection="column">
          <Text bold>SESSIONS · {working} working</Text>
          {rows.map(row => (
            <Box flexDirection="row" justifyContent="space-between" gap={1}>
              <Box flexDirection="row" gap={1} flexShrink={1}>
                <Text color={row.isWorking ? '#6CC08B' : 'inactive'}>{row.isWorking ? '●' : '○'}</Text>
                <Text bold={row.isWorking} wrap="truncate">{row.title}</Text>
              </Box>
              <Text dimColor>{row.isWorking ? 'working' : ago(row.lastActivityAt, now)}</Text>
            </Box>
          ))}
          {d.hasSessionList === false && <Text dimColor>Other sessions show up in the Claude desktop app.</Text>}
        </Box>
        <Box flexDirection="row" gap={2} alignItems="center">
          <Button key="refresh" label="Refresh" onPress={() => void refresh($).catch(() => undefined)} />
          <Text dimColor>{updated}</Text>
        </Box>
      </Box>
    )
  })
}
