const STORAGE_KEY = 'jobState'
const LAST_URL_KEY = 'lastUrl'

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
const outputValueEl = $('outputValue')
const urlInputEl = $('urlInput')

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

  errorValueEl.textContent = error
  listingValueEl.textContent = result?.listingUrl || '—'
  totalValueEl.textContent = Number.isFinite(total) ? String(total) : '0'

  const hrefs = Array.isArray(result?.hrefs) ? result.hrefs : []
  const aTags = Array.isArray(result?.aTags) ? result.aTags : []
  if (aTags.length) {
    outputValueEl.value = JSON.stringify(aTags, null, 2)
  } else {
    outputValueEl.value = hrefs.length ? JSON.stringify(hrefs, null, 2) : ''
  }
}

async function loadInitial() {
  const [stateRes, lastUrlRes] = await Promise.all([
    chrome.runtime.sendMessage({ type: 'GET_STATE' }),
    chrome.storage.local.get(LAST_URL_KEY),
  ])
  if (stateRes?.ok) render(stateRes.state)
  if (typeof lastUrlRes?.[LAST_URL_KEY] === 'string') {
    urlInputEl.value = lastUrlRes[LAST_URL_KEY]
  }
}

startBtn.addEventListener('click', async () => {
  const url = urlInputEl.value.trim()
  await chrome.storage.local.set({ [LAST_URL_KEY]: url })
  const res = await chrome.runtime.sendMessage({ type: 'START', url })
  if (!res?.ok) {
    errorValueEl.textContent = typeof res?.error === 'string' ? res.error : 'Failed to start.'
  }
})

stopBtn.addEventListener('click', async () => {
  const res = await chrome.runtime.sendMessage({ type: 'STOP' })
  if (!res?.ok) {
    errorValueEl.textContent = typeof res?.error === 'string' ? res.error : 'Failed to stop.'
  }
})

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return
  if (!changes[STORAGE_KEY]) return
  render(changes[STORAGE_KEY].newValue)
})

void loadInitial()
