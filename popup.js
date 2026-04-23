const STORAGE_KEY = 'jobState'

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

function render(state) {
  const progress = Math.max(0, Math.min(100, Number(state?.progress ?? 0)))
  const running = Boolean(state?.running)

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
}

async function loadInitial() {
  const res = await chrome.runtime.sendMessage({ type: 'GET_STATE' })
  if (res?.ok) render(res.state)
}

startBtn.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'START' })
})

stopBtn.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'STOP' })
})

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return
  if (!changes[STORAGE_KEY]) return
  render(changes[STORAGE_KEY].newValue)
})

void loadInitial()

