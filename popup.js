const STORAGE_KEY = 'jobState'
const TARGET_URL = 'https://ja.aliexpress.com/item/1005010133856596.html?gatewayAdapt=usa2jpn4itemAdapt'

function $(id) {
  const el = document.getElementById(id)
  if (!el) throw new Error(`Missing element: ${id}`)
  return el
}

const statusEl = $('status')
const progressBarEl = $('progressBar')
const progressLabelEl = $('progressLabel')
const progressHintEl = $('progressHint')
const startBtn = $('startBtn')
const stopBtn = $('stopBtn')
const errorValueEl = $('errorValue')
const listingValueEl = $('listingValue')
const totalValueEl = $('totalValue')
const listModeToggleEl = $('listModeToggle')
const listModeTextEl = $('listModeText')
let keepAlivePort = null
const LIST_MODE_KEY = 'listMode'

function setListModeUi(mode) {
  const m = mode === 'manual' ? 'manual' : 'auto'
  listModeToggleEl.checked = m === 'auto'
  listModeTextEl.textContent = m === 'auto' ? 'Auto' : 'Manual'
}

function render(state) {
  const progress = Math.max(0, Math.min(100, Number(state?.progress ?? 0)))
  const running = Boolean(state?.running)
  const error = typeof state?.error === 'string' ? state.error.trim() : ''
  const result = state?.result ?? null
  const total = Number(state?.total ?? 0)

  statusEl.textContent = running ? 'Running' : progress >= 100 ? 'Done' : 'Idle'
  progressBarEl.style.width = `${progress}%`
  progressLabelEl.textContent = `${progress}%`

  if (running) {
    progressHintEl.textContent = 'Working…'
  } else if (progress >= 100) {
    progressHintEl.textContent = 'Complete.'
  } else {
    progressHintEl.textContent = 'Ready.'
  }

  startBtn.disabled = running
  stopBtn.disabled = !running
  listModeToggleEl.disabled = running

  if (running) {
    if (!keepAlivePort) {
      try {
        keepAlivePort = chrome.runtime.connect({ name: 'keepalive' })
      } catch {}
    }
  } else if (keepAlivePort) {
    try {
      keepAlivePort.disconnect()
    } catch {}
    keepAlivePort = null
  }

  errorValueEl.textContent = error
  listingValueEl.textContent = result?.listingUrl || '—'
  totalValueEl.textContent = Number.isFinite(total) ? String(total) : '0'
}

async function loadInitial() {
  const stateRes = await chrome.runtime.sendMessage({ type: 'GET_STATE' })
  if (stateRes?.ok) render(stateRes.state)

  const { [LIST_MODE_KEY]: savedMode } = await chrome.storage.local.get(LIST_MODE_KEY)
  const mode = savedMode === 'manual' ? 'manual' : 'auto'
  if (savedMode !== 'manual' && savedMode !== 'auto') {
    await chrome.storage.local.set({ [LIST_MODE_KEY]: 'auto' })
  }
  setListModeUi(mode)
}

startBtn.addEventListener('click', async () => {
  const listMode = listModeToggleEl.checked ? 'auto' : 'manual'
  const res = await chrome.runtime.sendMessage({ type: 'START', url: TARGET_URL, listMode })
  if (!res?.ok) {
    errorValueEl.textContent = typeof res?.error === 'string' ? res.error : 'Failed to start.'
  }
})

stopBtn.addEventListener('click', async () => {
  const res = await chrome.runtime.sendMessage({ type: 'STOP' })
  if (!res?.ok) {
    errorValueEl.textContent = typeof res?.error === 'string' ? res.error : 'Failed to stop.'
  }
  if (keepAlivePort) {
    try {
      keepAlivePort.disconnect()
    } catch {}
    keepAlivePort = null
  }
})

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return
  if (changes[LIST_MODE_KEY]) {
    const v = changes[LIST_MODE_KEY]?.newValue
    setListModeUi(v === 'manual' ? 'manual' : 'auto')
  }
  if (!changes[STORAGE_KEY]) return
  render(changes[STORAGE_KEY].newValue)
})

listModeToggleEl.addEventListener('change', async () => {
  const listMode = listModeToggleEl.checked ? 'auto' : 'manual'
  setListModeUi(listMode)
  await chrome.storage.local.set({ [LIST_MODE_KEY]: listMode })
})

void loadInitial()
