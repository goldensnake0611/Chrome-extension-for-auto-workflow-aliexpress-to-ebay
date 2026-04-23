const STORAGE_KEY = 'jobState'
let currentJob = null
const TARGET_URL = 'https://ja.aliexpress.com/item/1005010133856596.html?gatewayAdapt=usa2jpn4itemAdapt'

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

function createAbortError() {
  const e = new Error('Stopped.')
  e.name = 'AbortError'
  return e
}

async function waitForTabComplete(tabId, signal, timeoutMs = 60000) {
  return await new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(createAbortError())
      return
    }

    let done = false

    const cleanup = () => {
      if (done) return
      done = true
      chrome.tabs.onUpdated.removeListener(onUpdated)
      if (timeoutId) clearTimeout(timeoutId)
      if (signal) signal.removeEventListener('abort', onAbort)
    }

    const onAbort = () => {
      cleanup()
      reject(createAbortError())
    }

    const onUpdated = (updatedTabId, info) => {
      if (updatedTabId !== tabId) return
      if (info?.status !== 'complete') return
      cleanup()
      resolve()
    }

    const timeoutId = setTimeout(() => {
      cleanup()
      reject(new Error('Timed out waiting for tab load.'))
    }, timeoutMs)

    chrome.tabs.onUpdated.addListener(onUpdated)
    if (signal) signal.addEventListener('abort', onAbort, { once: true })
  })
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
  const tab = Array.isArray(tabs) ? tabs[0] : null
  const tabId = tab?.id
  if (typeof tabId !== 'number') throw new Error('No active tab found.')

  const tabUrl = typeof tab?.url === 'string' ? tab.url : ''
  if (!isHttpUrl(tabUrl)) {
    throw new Error('Please open the AliExpress page in the current tab first.')
  }
  if (!tabUrl.includes('aliexpress.')) {
    throw new Error('Please open the AliExpress page in the current tab first.')
  }
  return { tabId, tabUrl, status: tab?.status }
}

async function scrapeHrefsFromTab(tabId, fallbackUrl, status, signal) {
  if (status !== 'complete') {
    await waitForTabComplete(tabId, signal, 60000)
  }
  if (signal?.aborted) throw createAbortError()

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: async () => {
      const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

      const autoScrollAndLoad = async () => {
        let previousHeight = 0
        let sameCount = 0
        let loops = 0
        const hrefSet = new Set()

        const collectHrefs = () => {
          const anchors = Array.from(document.querySelectorAll('a'))
          for (const a of anchors) {
            if (!a || !a.classList) continue
            if (!a.classList.contains('_3mPKP') && !a.classList.contains('3mPKP')) continue

            const raw = (a.getAttribute('href') || '').trim()
            if (!raw) continue
            if (raw.startsWith('#')) continue
            if (raw.startsWith('javascript:')) continue
            if (raw.startsWith('mailto:')) continue

            let abs = ''
            try {
              abs = new URL(raw, location.href).toString()
            } catch {
              abs = (a.href || '').trim()
            }
            if (!abs.startsWith('http://') && !abs.startsWith('https://')) continue

            hrefSet.add(abs)
            if (hrefSet.size >= 100) break
          }
        }

        collectHrefs()

        while (hrefSet.size < 100) {
          window.scrollTo(0, document.body.scrollHeight)
          await sleep(2000)

          const showMoreBtn = document.querySelector(
            'button.comet-v2-btn.comet-v2-btn-primary.comet-v2-btn-large.comet-v2-btn-important'
          )
          if (showMoreBtn) {
            try {
              showMoreBtn.click()
            } catch {}
            await sleep(2000)
          }

          collectHrefs()
          if (hrefSet.size >= 100) break

          const newHeight = document.body.scrollHeight
          if (newHeight === previousHeight) {
            sameCount++
          } else {
            sameCount = 0
          }
          if (sameCount >= 3) break
          previousHeight = newHeight

          loops++
          if (loops >= 80) break
        }

        return Array.from(hrefSet).slice(0, 100)
      }

      const hrefs = await autoScrollAndLoad()
      return { finalUrl: location.href, hrefs }
    },
  })

  const first = Array.isArray(results) ? results[0] : null
  const payload = first?.result ?? null
  const finalUrl = typeof payload?.finalUrl === 'string' ? payload.finalUrl : fallbackUrl
  const hrefs = Array.isArray(payload?.hrefs) ? payload.hrefs : []

  return { finalUrl, hrefs, aTags: [] }
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

      const targetUrl = TARGET_URL

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
        const { tabId, tabUrl, status } = await getActiveTab()
        const { finalUrl, hrefs: hrefsRaw, aTags } = await scrapeHrefsFromTab(
          tabId,
          tabUrl,
          status,
          abortController.signal
        )
        const hrefs = [...new Set(hrefsRaw)].filter(Boolean).slice(0, 100)
        const aTagsList = Array.isArray(aTags) ? aTags : []
        const total = aTagsList.length ? aTagsList.length : hrefs.length

        await setState({ total, scraped: total, progress: 90 })
        await stopJob({
          progress: 100,
          result: { listingUrl: targetUrl, hrefs, aTags: aTagsList, finalUrl },
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
