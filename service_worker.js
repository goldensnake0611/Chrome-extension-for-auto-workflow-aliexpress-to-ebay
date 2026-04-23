const STORAGE_KEY = 'jobState'
let currentJob = null
const TARGET_URL = 'https://ja.aliexpress.com/item/1005010133856596.html?gatewayAdapt=usa2jpn4itemAdapt'
const HREF_LIMIT = 2
const keepAlivePorts = new Set()

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
    let intervalId = null
    let timeoutId = null

    const cleanup = () => {
      if (done) return
      done = true
      chrome.tabs.onUpdated.removeListener(onUpdated)
      if (timeoutId) clearTimeout(timeoutId)
      if (intervalId) clearInterval(intervalId)
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

    timeoutId = setTimeout(() => {
      cleanup()
      reject(new Error('Timed out waiting for tab load.'))
    }, timeoutMs)

    chrome.tabs.onUpdated.addListener(onUpdated)
    if (signal) signal.addEventListener('abort', onAbort, { once: true })

    intervalId = setInterval(() => {
      ;(async () => {
        if (done) return
        try {
          const tab = await chrome.tabs.get(tabId)
          if (tab?.status === 'complete') {
            cleanup()
            resolve()
          }
        } catch {}
      })()
    }, 500)
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
    func: async hrefLimit => {
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
            if (hrefSet.size >= hrefLimit) break
          }
        }

        collectHrefs()

        while (hrefSet.size < hrefLimit) {
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
          if (hrefSet.size >= hrefLimit) break

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

        return Array.from(hrefSet).slice(0, hrefLimit)
      }

      const hrefs = await autoScrollAndLoad()
      return { finalUrl: location.href, hrefs }
    },
    args: [HREF_LIMIT],
  })

  const first = Array.isArray(results) ? results[0] : null
  const payload = first?.result ?? null
  const finalUrl = typeof payload?.finalUrl === 'string' ? payload.finalUrl : fallbackUrl
  const hrefs = Array.isArray(payload?.hrefs) ? payload.hrefs : []

  return { finalUrl, hrefs, aTags: [] }
}

async function scrapeProductDetailFromTab(tabId, fallbackUrl, status, signal) {
  if (status !== 'complete') {
    await waitForTabComplete(tabId, signal, 60000)
  }
  if (signal?.aborted) throw createAbortError()

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: async () => {
      const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

      const extractAfterColon = value => {
        const text = ((value || '') + '').trim()
        const idx = text.indexOf(':')
        return idx >= 0 ? text.slice(idx + 1).trim() : text
      }

      const readText = selector => {
        const el = document.querySelector(selector)
        const text = (el?.innerText || '').trim()
        return text
      }

      const readMeta = selector => {
        const el = document.querySelector(selector)
        const content = (el?.getAttribute?.('content') || '').trim()
        return content
      }

      const readTextAny = selectors => {
        for (const selector of selectors) {
          const t = readText(selector)
          if (t) return t
        }
        return ''
      }

      const findSpecValue = labelMatchers => {
        const nodes = Array.from(document.querySelectorAll('dl, tr, li, div'))
        for (const node of nodes) {
          const text = ((node?.textContent || node?.innerText || '') + '').trim()
          if (!text) continue
          if (!labelMatchers.some(m => (typeof m === 'string' ? text.includes(m) : m.test(text)))) continue

          const dd = node.querySelector?.('dd')
          if (dd) {
            const v = ((dd.textContent || dd.innerText || '') + '').trim()
            if (v) return v
          }

          const td = node.querySelector?.('td:last-child')
          if (td) {
            const v = ((td.textContent || td.innerText || '') + '').trim()
            if (v) return v
          }

          const next = node.nextElementSibling
          if (next) {
            const v = ((next.textContent || next.innerText || '') + '').trim()
            if (v) return v
          }
        }
        return ''
      }

      for (let i = 0; i < 30; i++) {
        const title = readText('h1')
        const price = readText('.price-kr--current--NhhwBO1')
        if (title || price) break
        await sleep(500)
      }

      const images = Array.from(document.querySelectorAll('div.slider--wrap--dfLgmYD img'))
        .map(img => (img?.currentSrc || img?.src || img?.getAttribute('src') || '').trim())
        .filter(Boolean)

      const quantityRaw = readText('.quantity--info--jnoo_pD')
      const quantity =
        quantityRaw === 'Limit one per customer.' || quantityRaw === 'お一人様1点限り' ? 1 : quantityRaw

      const shippingCostRaw = readText('.dynamic-shipping-titleLayout')
      const shippingCost =
        shippingCostRaw === '送料無料' || shippingCostRaw === 'Free shipping' ? 0 : shippingCostRaw

      const shippingService = (() => {
        const roots = Array.from(document.querySelectorAll('.dynamic-shipping-contentLayout'))
        const root = roots[1]
        if (!root) return ''
        const text = ((root.textContent || root.innerText || '') + '').trim()
        return extractAfterColon(text)
      })()
      const handlingTime = (() => {
        const roots = Array.from(document.querySelectorAll('.dynamic-shipping-contentLayout'))
        const root = roots[0]
        if (!root) return ''
        const text = ((root.textContent || root.innerText || '') + '').trim()
        return extractAfterColon(text)
      })()

      const category = (() => {
        const meta = readMeta('meta[property="og:category"]')
        if (meta) return meta
        const crumbs = Array.from(
          document.querySelectorAll('a[href*="/category/"], a[href*="category/"], nav a, ol li a')
        )
          .map(a => ((a?.textContent || a?.innerText || '') + '').trim())
          .filter(Boolean)
        const unique = Array.from(new Set(crumbs)).slice(0, 6)
        return unique.length ? unique.join(' > ') : ''
      })()

      const brand = (() => {
        const v = findSpecValue([/brand/i, /ブランド/])
        return v
      })()

      const categoryCondition = (() => {
        const v = findSpecValue([/condition/i, /状態/, /コンディション/])
        return v || 'New'
      })()

      const customLabelSku = (() => {
        const url = location.href || ''
        const m = url.match(/\/item\/(\d+)\.html/i) || url.match(/item\/(\d+)\.html/i)
        return m?.[1] ? String(m[1]) : ''
      })()

      const priceFormat = (() => {
        const priceText = readText('.price-kr--current--NhhwBO1')
        if (priceText.includes('-') || priceText.includes('–')) return 'Range'
        return 'Fixed'
      })()

      const description = readTextAny([
        '#product-description',
        '[data-pl="product-description"]',
        '.product-description',
        '[id*="description"]',
      ]) || readMeta('meta[name="description"]')

      const itemLocation = await (async () => {
        const trigger = document.querySelector('div.store-detail--storeNameWrap--Z45gRHH')
        if (!trigger) return ''

        const beforeTables = new Set(Array.from(document.querySelectorAll('table')))
        try {
          const rect = trigger.getBoundingClientRect()
          const x = rect.left + Math.min(10, Math.max(1, rect.width / 2))
          const y = rect.top + Math.min(10, Math.max(1, rect.height / 2))
          trigger.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, cancelable: true, clientX: x, clientY: y }))
          trigger.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true, clientX: x, clientY: y }))
          trigger.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX: x, clientY: y }))
        } catch {}

        await sleep(600)

        const allTables = Array.from(document.querySelectorAll('table'))
        const candidateTables = allTables.filter(t => !beforeTables.has(t))
        const tablesToCheck = candidateTables.length ? candidateTables : allTables

        for (const table of tablesToCheck) {
          const rows = Array.from(table.querySelectorAll('tr'))
          if (rows.length < 3) continue
          const cells = Array.from(rows[2].querySelectorAll('td, th'))
          if (cells.length < 2) continue
          const value = ((cells[1].textContent || cells[1].innerText || '') + '').trim()
          if (value) return value
        }

        return ''
      })()

      return {
        finalUrl: location.href,
        detail: {
          title: readText('h1'),
          price: readText('.price-kr--current--NhhwBO1'),
          images: Array.from(new Set(images)),
          quantity,
          shippingService,
          shippingCost,
          handlingTime,
          'Item location': itemLocation,
          Category: category,
          'Category Condition': categoryCondition,
          Brand: brand,
          'Custom Label (SKU)': customLabelSku,
          'Price Format': priceFormat,
          Description: description,
        },
      }
    },
  })

  const first = Array.isArray(results) ? results[0] : null
  const payload = first?.result ?? null

  return {
    finalUrl: typeof payload?.finalUrl === 'string' ? payload.finalUrl : fallbackUrl,
    detail: payload?.detail && typeof payload.detail === 'object' ? payload.detail : null,
  }
}

async function updateTabUrl(tabId, url, signal) {
  if (signal?.aborted) throw createAbortError()
  await chrome.tabs.update(tabId, { url })
  await waitForTabComplete(tabId, signal, 60000)
  if (signal?.aborted) throw createAbortError()
}

chrome.runtime.onInstalled.addListener(async () => {
  const state = await getState()
  await chrome.storage.local.set({ [STORAGE_KEY]: state })
})

chrome.runtime.onConnect.addListener(port => {
  keepAlivePorts.add(port)
  port.onDisconnect.addListener(() => {
    keepAlivePorts.delete(port)
  })
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
        const { finalUrl: listingFinalUrl, hrefs } = await scrapeHrefsFromTab(
          tabId,
          tabUrl,
          status,
          abortController.signal
        )

        const total = Array.isArray(hrefs) ? hrefs.length : 0
        await setState({ total, scraped: 0 })

        const details = []
        for (let i = 0; i < total; i++) {
          if (abortController.signal.aborted) throw createAbortError()
          const href = hrefs[i]
          if (typeof href !== 'string' || !href) continue

          try {
            await updateTabUrl(tabId, href, abortController.signal)
            const { detail } = await scrapeProductDetailFromTab(
              tabId,
              href,
              'complete',
              abortController.signal
            )
            if (detail) details.push(detail)
          } catch {}

          const scraped = i + 1
          const pct = total ? Math.floor((scraped / total) * 65) : 0
          await setState({ scraped, progress: 25 + pct })
        }

        try {
          await updateTabUrl(tabId, tabUrl, abortController.signal)
        } catch {}

        await setState({ total, scraped: total, progress: 90 })
        await stopJob({
          progress: 100,
          result: { listingUrl: targetUrl, finalUrl: listingFinalUrl, details },
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

    if (message?.type === 'SCRAPE_DETAIL') {
      try {
        const { tabId, tabUrl, status } = await getActiveTab()
        const { finalUrl, detail } = await scrapeProductDetailFromTab(tabId, tabUrl, status, null)
        sendResponse({ ok: true, finalUrl, detail })
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Scrape failed.'
        sendResponse({ ok: false, error: msg })
      }
      return
    }

    sendResponse({ ok: false, error: 'Unknown message type' })
  })()

  return true
})
