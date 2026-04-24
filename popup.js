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
let keepAlivePort = null

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
}

startBtn.addEventListener('click', async () => {
  const res = await chrome.runtime.sendMessage({ type: 'START', url: TARGET_URL })
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
  if (!changes[STORAGE_KEY]) return
  render(changes[STORAGE_KEY].newValue)
})

void loadInitial()
