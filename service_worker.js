const STORAGE_KEY = 'jobState'
const ALARM_NAME = 'jobTick'

async function getState() {
  const { [STORAGE_KEY]: state } = await chrome.storage.local.get(STORAGE_KEY)
  return (
    state ?? {
      running: false,
      progress: 0,
      startedAt: null,
      finishedAt: null,
    }
  )
}

async function setState(patch) {
  const prev = await getState()
  const next = { ...prev, ...patch }
  await chrome.storage.local.set({ [STORAGE_KEY]: next })
  return next
}

async function stopJob() {
  await chrome.alarms.clear(ALARM_NAME)
  await setState({ running: false, finishedAt: Date.now() })
}

async function tick() {
  const state = await getState()
  if (!state.running) {
    await chrome.alarms.clear(ALARM_NAME)
    return
  }

  const nextProgress = Math.min(100, (state.progress ?? 0) + 5)
  const next = await setState({ progress: nextProgress })
  if (next.progress >= 100) await stopJob()
}

chrome.runtime.onInstalled.addListener(async () => {
  const state = await getState()
  await chrome.storage.local.set({ [STORAGE_KEY]: state })
})

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  ;(async () => {
    if (message?.type === 'START') {
      await chrome.alarms.clear(ALARM_NAME)
      await setState({ running: true, progress: 0, startedAt: Date.now(), finishedAt: null })
      await chrome.alarms.create(ALARM_NAME, { periodInMinutes: 1 / 60 })
      sendResponse({ ok: true })
      return
    }

    if (message?.type === 'STOP') {
      await stopJob()
      sendResponse({ ok: true })
      return
    }

    if (message?.type === 'GET_STATE') {
      const state = await getState()
      sendResponse({ ok: true, state })
      return
    }

    sendResponse({ ok: false, error: 'Unknown message type' })
  })()

  return true
})

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm?.name !== ALARM_NAME) return
  void tick()
})

