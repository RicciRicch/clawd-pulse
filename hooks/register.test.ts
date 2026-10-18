import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const NOW = Date.parse('2026-10-12T17:10:00.000Z')
const PANE = {
  component: 'Pane',
  requestId: 'clawd-pulse',
  props: {
    title: 'Clawd Pulse',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const SESSIONS = [
  { sessionId: 'a', title: 'Website redesign', isRunning: true, lastActivityAt: '2026-10-12T17:00:00.000Z' },
  { sessionId: 'b', title: 'Slides', isRunning: false, lastActivityAt: '2026-10-11T02:00:00.000Z' },
]

// The desktop app's session tools, answered from memory.
function desktopApp(on: On, fiveHourPct: number) {
  mock.clock(on, { now: NOW })
  on('mcp.call', ($, e) => {
    const body =
      e.tool === 'list_sessions'
        ? SESSIONS
        : {
            plan: {
              status: 'ok',
              plan: 'Pro',
              windows: [
                { label: '5-hour limit', percentUsed: fiveHourPct, resetsAt: '2026-10-12T21:50:00.000Z' },
                { label: 'Weekly · all models', percentUsed: 10, resetsAt: '2026-10-18T12:00:00.000Z' },
              ],
            },
          }
    return { value: { content: [{ type: 'text', text: JSON.stringify(body) }], isError: false } }
  })
}

test('the dashboard draws sessions, limits and a working Clawd', async ($, on) => {
  desktopApp(on, 15)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'clawd-pulse', surface, ...PANE })
    await ui.press({ key: 'refresh' })
    expect(await ui.find({ text: /Website redesign/ })).toBeDefined()
    expect(await ui.find({ text: /1 working/ })).toBeDefined()
    if (surface === 'desktop') {
      const alt = String((await ui.find({ type: 'Svg' }))?.props.alt)
      expect(alt).toMatch(/Clawd is working/)
      expect(alt).toMatch(/5-hour limit 15%/)
    }
    await ui.unmount()
  }
})

test('Clawd falls asleep when a limit is spent', async ($, on) => {
  desktopApp(on, 100)
  const ui = await $.ui.mount({ plugin: 'clawd-pulse', surface: 'desktop', ...PANE })
  await ui.press({ key: 'refresh' })
  expect(String((await ui.find({ type: 'Svg' }))?.props.alt)).toMatch(/Clawd is sleeping/)
  await ui.unmount()
})
