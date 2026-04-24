const STORAGE_KEY = 'jobState'
let currentJob = null
const TARGET_URL = 'https://ja.aliexpress.com/item/1005010133856596.html?gatewayAdapt=usa2jpn4itemAdapt'
const HREF_LIMIT = 1
const DOWNLOAD_BASE_DIR = 'AliExpressScraper'
const EBAY_LISTING_URL = 'https://ebay-mock-page.vercel.app/'
const JPY_TO_USD_RATE = 0.0065
const keepAlivePorts = new Set()

function sanitizePathSegment(input) {
  const raw = ((input ?? '') + '').trim()
  const cleaned = raw
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
  const short = cleaned.length > 80 ? cleaned.slice(0, 80).replace(/[. ]+$/g, '') : cleaned
  return short || 'item'
}

function getImageExtension(url) {
  try {
    const u = new URL(url)
    const path = u.pathname || ''
    const m = path.match(/\.([a-zA-Z0-9]{2,5})$/)
    const ext = (m?.[1] || '').toLowerCase()
    if (ext && ext.length <= 5) return ext
  } catch {}
  return 'jpg'
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer)
  const chunkSize = 0x8000
  let binary = ''
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  }
  return btoa(binary)
}

async function fetchImageAsDataUrl(url, signal) {
  if (signal?.aborted) throw createAbortError()
  const res = await fetch(url, { signal })
  if (!res.ok) throw new Error(`Image fetch failed (${res.status}).`)
  const blob = await res.blob()
  const buffer = await blob.arrayBuffer()
  const base64 = arrayBufferToBase64(buffer)
  const type = blob.type || 'image/jpeg'
  return { dataUrl: `data:${type};base64,${base64}`, type }
}

function round2Number(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return ''
  return Math.round(n * 100) / 100
}

function normalizeCurrency(value) {
  const t = String(value ?? '').trim().toUpperCase()
  if (!t) return ''
  if (t === 'JPY' || t === 'YEN' || t.includes('円')) return 'JPY'
  return t
}

function normalizeNumberLike(value) {
  const text = ((value ?? '') + '').trim()
  if (!text) return ''
  const m = text.match(/(\d[\d,]*)(\.\d+)?/)
  if (!m) return ''
  return (m[1] + (m[2] || '')).replace(/,/g, '')
}

async function ensureEbayTab(signal) {
  if (signal?.aborted) throw createAbortError()
  const tabs = await chrome.tabs.query({})
  const existing = (Array.isArray(tabs) ? tabs : []).find(
    t => typeof t?.url === 'string' && t.url.startsWith(EBAY_LISTING_URL)
  )
  if (existing?.id && typeof existing.id === 'number') return existing.id
  const tab = await chrome.tabs.create({ url: EBAY_LISTING_URL, active: true })
  if (typeof tab?.id !== 'number') throw new Error('Failed to open eBay page.')
  return tab.id
}

async function fillEbayListing(detail, signal) {
  if (!detail || typeof detail !== 'object') return
  const tabId = await ensureEbayTab(signal)
  try {
    await chrome.tabs.update(tabId, { active: true })
  } catch {}
  await waitForTabComplete(tabId, signal, 60000)
  if (signal?.aborted) throw createAbortError()

  const imageUrls = Array.isArray(detail.images) ? detail.images.filter(u => typeof u === 'string' && u) : []
  const photos = []
  for (let i = 0; i < Math.min(24, imageUrls.length); i++) {
    if (signal?.aborted) throw createAbortError()
    const url = imageUrls[i]
    try {
      const { dataUrl, type } = await fetchImageAsDataUrl(url, signal)
      const extFromType = (type || '').split('/')[1] || ''
      const ext = extFromType ? extFromType.toLowerCase() : getImageExtension(url)
      const index = String(i + 1).padStart(2, '0')
      photos.push({ name: `${index}.${ext}`, dataUrl })
    } catch {}
  }

  const priceCurrency = normalizeCurrency(detail.priceCurrency)
  const priceRaw = normalizeNumberLike(detail.price)
  const priceUsd =
    priceCurrency === 'JPY' ? String(round2Number(Number(priceRaw || 0) * JPY_TO_USD_RATE)) : priceRaw

  const shippingCurrency = normalizeCurrency(detail.shippingCostCurrency)
  const shippingRaw = normalizeNumberLike(detail.shippingCost)
  const shippingCostUsd =
    shippingCurrency === 'JPY'
      ? String(round2Number(Number(shippingRaw || 0) * JPY_TO_USD_RATE))
      : String(detail.shippingCost ?? '')

  const payload = {
    title: detail.title || '',
    priceFormat: detail['Price Format'] || '',
    price: priceUsd,
    quantity: String(detail.quantity ?? ''),
    shippingCost: shippingCostUsd,
    handlingTime: String(detail.handlingTime ?? ''),
    itemLocation: String(detail['Item location'] ?? ''),
    photos,
  }

  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['ebay_filler.js'] })
  } catch {}

  for (let i = 0; i < 40; i++) {
    if (signal?.aborted) throw createAbortError()
    try {
      const res = await chrome.scripting.executeScript({
        target: { tabId },
        func: async p => {
          if (typeof globalThis.fillEbayFormAsync !== 'function') {
            throw new Error('fillEbayFormAsync is missing.')
          }
          await globalThis.fillEbayFormAsync(p)
          return { ok: true }
        },
        args: [payload],
      })
      const first = Array.isArray(res) ? res[0] : null
      if (first?.result?.ok) return
    } catch {}
    await new Promise(r => setTimeout(r, 500))
  }
}

async function downloadImagesToFolder(imageUrls, title, signal) {
  const urls = Array.isArray(imageUrls) ? imageUrls.filter(u => typeof u === 'string' && u) : []
  const unique = Array.from(new Set(urls))
  if (!unique.length) return []

  const safeTitle = sanitizePathSegment(title)
  const folder = `${DOWNLOAD_BASE_DIR}/${safeTitle}`
  const downloadIds = []

  for (let i = 0; i < unique.length; i++) {
    if (signal?.aborted) throw createAbortError()
    const url = unique[i]
    const ext = getImageExtension(url)
    const index = String(i + 1).padStart(2, '0')
    const filename = `${folder}/${index}.${ext}`
    try {
      const id = await chrome.downloads.download({ url, filename, conflictAction: 'uniquify', saveAs: false })
      if (typeof id === 'number') downloadIds.push(id)
    } catch {}
  }

  return downloadIds
}

async function waitForDownloadComplete(downloadId, signal, timeoutMs = 60000) {
  if (signal?.aborted) throw createAbortError()

  try {
    const items = await chrome.downloads.search({ id: downloadId })
    const item = Array.isArray(items) ? items[0] : null
    if (item?.state === 'complete') return
    if (item?.state === 'interrupted') throw new Error('Download interrupted.')
  } catch {}

  await new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(createAbortError())
      return
    }

    let done = false
    let timeoutId = null

    const cleanup = () => {
      if (done) return
      done = true
      if (timeoutId) clearTimeout(timeoutId)
      chrome.downloads.onChanged.removeListener(onChanged)
      if (signal) signal.removeEventListener('abort', onAbort)
    }

    const onAbort = () => {
      cleanup()
      reject(createAbortError())
    }

    const onChanged = delta => {
      if (!delta || delta.id !== downloadId) return
      if (delta.state?.current === 'complete') {
        cleanup()
        resolve()
        return
      }
      if (delta.state?.current === 'interrupted') {
        cleanup()
        reject(new Error('Download interrupted.'))
      }
    }

    timeoutId = setTimeout(() => {
      cleanup()
      reject(new Error('Download timed out.'))
    }, timeoutMs)

    chrome.downloads.onChanged.addListener(onChanged)
    if (signal) signal.addEventListener('abort', onAbort, { once: true })
  })
}

async function removeDownloadedFiles(downloadIds) {
  const ids = Array.isArray(downloadIds) ? downloadIds.filter(id => typeof id === 'number') : []
  for (const id of ids) {
    try {
      await chrome.downloads.removeFile(id)
    } catch {}
    try {
      await chrome.downloads.erase({ id })
    } catch {}
  }
}

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

      const parseMoney = value => {
        const text = ((value || '') + '').trim()
        if (!text) return { amount: null, currency: '' }

        const currency = /usd|\$|us\s*\$/i.test(text)
          ? 'USD'
          : /jpy|yen|円|¥|￥/i.test(text)
            ? 'JPY'
            : /eur|€/i.test(text)
              ? 'EUR'
              : /gbp|£/i.test(text)
                ? 'GBP'
                : /aud/i.test(text)
                  ? 'AUD'
                  : /cad/i.test(text)
                    ? 'CAD'
                    : /krw|₩/i.test(text)
                      ? 'KRW'
                      : /cny|rmb|￥/i.test(text)
                        ? 'CNY'
                        : ''

        const m = text.match(/(\d[\d,]*)(\.\d+)?/)
        if (!m) return { amount: null, currency }
        const amount = Number((m[1] + (m[2] || '')).replace(/,/g, ''))
        return { amount: Number.isFinite(amount) ? amount : null, currency }
      }

      const businessDaysFromRange = value => {
        const text = ((value || '') + '').trim()
        let startMonth = null
        let startDay = null
        let endMonth = null
        let endDay = null

        const jp = text.match(
          /(\d{1,2})\s*月\s*(\d{1,2})\s*[^0-9]*[-–〜~]\s*(\d{1,2})\s*月\s*(\d{1,2})/i
        )
        if (jp) {
          startMonth = Number(jp[1])
          startDay = Number(jp[2])
          endMonth = Number(jp[3])
          endDay = Number(jp[4])
        } else {
          const monthMap = {
            jan: 1,
            january: 1,
            feb: 2,
            february: 2,
            mar: 3,
            march: 3,
            apr: 4,
            april: 4,
            may: 5,
            jun: 6,
            june: 6,
            jul: 7,
            july: 7,
            aug: 8,
            august: 8,
            sep: 9,
            sept: 9,
            september: 9,
            oct: 10,
            october: 10,
            nov: 11,
            november: 11,
            dec: 12,
            december: 12,
          }

          const en = text.match(
            /([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?\s*[-–〜~]\s*(?:([a-z]+)\s+)?(\d{1,2})(?:st|nd|rd|th)?/i
          )
          if (!en) return null

          startMonth = monthMap[String(en[1]).toLowerCase()] ?? null
          startDay = Number(en[2])
          endMonth = en[3] ? monthMap[String(en[3]).toLowerCase()] ?? null : startMonth
          endDay = Number(en[4])
        }

        if (!Number.isFinite(startMonth) || !Number.isFinite(startDay) || !Number.isFinite(endMonth) || !Number.isFinite(endDay)) {
          return null
        }

        const year = new Date().getFullYear()
        const start = new Date(year, startMonth - 1, startDay)
        let end = new Date(year, endMonth - 1, endDay)
        if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null
        if (end.getTime() < start.getTime()) end = new Date(year + 1, endMonth - 1, endDay)

        let count = 0
        const cursor = new Date(start.getTime())
        for (let i = 0; i < 400; i++) {
          const day = cursor.getDay()
          if (day !== 0 && day !== 6) count++
          if (cursor.getTime() >= end.getTime()) break
          cursor.setDate(cursor.getDate() + 1)
        }
        return count
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

      const normalizeCurrency = value => {
        const t = ((value || '') + '').trim().toUpperCase()
        if (!t) return ''
        if (t === 'JPY' || t === 'YEN' || t.includes('円')) return 'JPY'
        return t
      }

      const pageCurrency = normalizeCurrency(
        readMeta('meta[property="og:price:currency"]') ||
        readMeta('meta[property="product:price:currency"]') ||
        readMeta('meta[name="currency"]') ||
        ''
      )

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
        quantityRaw === 'Limit one per customer.' ? 1 : quantityRaw

      const shippingCostRaw = readText('.dynamic-shipping-titleLayout')
      const shippingCostMoney =
        shippingCostRaw === 'Free shipping'
          ? { amount: 0, currency: 'USD' }
          : (() => {
              const m = parseMoney(shippingCostRaw)
              return { amount: m.amount, currency: m.currency || pageCurrency || 'JPY' }
            })()

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
        const value = extractAfterColon(text)
        const days = businessDaysFromRange(value)
        return days ?? value
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
        const v = findSpecValue([/brand/])
        return v
      })()

      const categoryCondition = (() => {
        const v = findSpecValue([/condition/])
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

      const priceRaw = readText('.price-kr--current--NhhwBO1')
      const priceMoney = (() => {
        const m = parseMoney(priceRaw)
        return { amount: m.amount, currency: m.currency || pageCurrency || 'JPY' }
      })()

      return {
        finalUrl: location.href,
        detail: {
          title: readText('h1'),
          price: priceMoney.amount ?? '',
          priceCurrency: priceMoney.currency || '',
          images: Array.from(new Set(images)),
          quantity,
          shippingService,
          shippingCost: shippingCostMoney.amount ?? '',
          shippingCostCurrency: shippingCostMoney.currency || '',
          handlingTime,
          'Item location': itemLocation,
          Category: category,
          'Category Condition': categoryCondition,
          Brand: brand,
          'Custom Label (SKU)': customLabelSku,
          'Price Format': priceFormat,
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
        const downloadIdsForCleanup = []
        if (total === 0) {
          try {
            const { detail } = await scrapeProductDetailFromTab(
              tabId,
              tabUrl,
              status,
              abortController.signal
            )
            if (detail) {
              const ids = await downloadImagesToFolder(
                detail.images,
                detail.title || detail['Custom Label (SKU)'] || 'item',
                abortController.signal
              )
              if (Array.isArray(ids) && ids.length) downloadIdsForCleanup.push(...ids)
              details.push(detail)
            }
          } catch {}
        }
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
            if (detail) {
              const ids = await downloadImagesToFolder(
                detail.images,
                detail.title || detail['Custom Label (SKU)'] || 'item',
                abortController.signal
              )
              if (Array.isArray(ids) && ids.length) downloadIdsForCleanup.push(...ids)
              details.push(detail)
            }
          } catch {}

          const scraped = i + 1
          const pct = total ? Math.floor((scraped / total) * 65) : 0
          await setState({ scraped, progress: 25 + pct })
        }

        try {
          await updateTabUrl(tabId, tabUrl, abortController.signal)
        } catch {}

        if (details.length) {
          try {
            await fillEbayListing(details[0], abortController.signal)
          } catch {}
        }

        if (downloadIdsForCleanup.length) {
          for (const id of downloadIdsForCleanup) {
            try {
              await waitForDownloadComplete(id, abortController.signal, 60000)
            } catch {}
          }
          await removeDownloadedFiles(downloadIdsForCleanup)
        }

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
