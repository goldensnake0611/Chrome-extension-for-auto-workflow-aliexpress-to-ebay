const STORAGE_KEY = 'jobState'
let currentJob = null
const PUPPETEER_SERVICE_URL = 'http://localhost:3007/hrefs'

async function getState() {
  const { [STORAGE_KEY]: state } = await chrome.storage.local.get(STORAGE_KEY)
  return (
    state ?? {
      running: false,
      progress: 0,
      startedAt: null,
      finishedAt: null,
      result: null,
      error: null,
      total: 0,
      scraped: 0,
    }
  )
}

async function setState(patch) {
  const prev = await getState()
  const next = { ...prev, ...patch }
  await chrome.storage.local.set({ [STORAGE_KEY]: next })
  return next
}

async function stopJob(patch = {}) {
  await setState({ running: false, finishedAt: Date.now(), ...patch })
}

function isHttpUrl(url) {
  if (!url) return false
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

async function fetchHrefsWithPuppeteer(targetUrl, signal) {
  const u = new URL(PUPPETEER_SERVICE_URL)
  u.searchParams.set('url', targetUrl)
  const res = await fetch(u.toString(), { signal })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(text || `Puppeteer service error (${res.status}).`)
  }
  const data = await res.json().catch(() => null)
  if (!data?.ok || !Array.isArray(data?.hrefs)) {
    throw new Error(typeof data?.error === 'string' ? data.error : 'Invalid puppeteer response.')
  }
  return {
    finalUrl: typeof data?.finalUrl === 'string' ? data.finalUrl : targetUrl,
    hrefs: data.hrefs,
    aTags: Array.isArray(data?.aTags) ? data.aTags : null,
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  const state = await getState()
  await chrome.storage.local.set({ [STORAGE_KEY]: state })
})

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  ;(async () => {
    if (message?.type === 'START') {
      if (currentJob) {
        sendResponse({ ok: false, error: 'Already running' })
        return
      }

      const targetUrl = typeof message?.url === 'string' ? message.url.trim() : ''
      if (!isHttpUrl(targetUrl)) {
        sendResponse({ ok: false, error: 'Please provide a valid http(s) URL.' })
        return
      }

      await setState({
        running: true,
        progress: 5,
        startedAt: Date.now(),
        finishedAt: null,
        result: null,
        error: null,
        total: 0,
        scraped: 0,
      })

      const abortController = new AbortController()
      const job = { aborted: false, abortController }
      currentJob = job
      sendResponse({ ok: true })

      try {
        await setState({ progress: 10 })
        if (job.aborted) throw new Error('Stopped.')

        await setState({ progress: 25 })
        const { finalUrl, hrefs: hrefsRaw, aTags } = await fetchHrefsWithPuppeteer(
          targetUrl,
          abortController.signal
        )
        const hrefs = [...new Set(hrefsRaw)].filter(Boolean)
        const aTagsList = Array.isArray(aTags) ? aTags : []
        const total = aTagsList.length ? aTagsList.length : hrefs.length

        await setState({ total, scraped: total, progress: 90 })
        await stopJob({
          progress: 100,
          result: { listingUrl: finalUrl, hrefs, aTags: aTagsList },
          error: null,
        })
      } catch (e) {
        const msg =
          e instanceof Error && e.name === 'AbortError'
            ? 'Stopped.'
            : e instanceof Error
              ? e.message
              : 'Scrape failed.'
        await stopJob({ progress: 0, error: msg })
      } finally {
        if (currentJob === job) currentJob = null
      }

      return
    }

    if (message?.type === 'STOP') {
      const job = currentJob
      if (job) job.aborted = true
      if (job?.abortController) {
        try {
          job.abortController.abort()
        } catch {}
      }
      currentJob = null
      await stopJob({ progress: 0 })
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
