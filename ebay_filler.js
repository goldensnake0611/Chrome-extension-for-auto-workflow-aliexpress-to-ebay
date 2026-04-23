function $(id) {
  return document.getElementById(id)
}

function setInputValue(el, value) {
  if (!el) return false
  el.focus?.()
  el.value = value
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
  return true
}

function setSelectValue(el, value) {
  if (!el) return false
  const v = String(value ?? '')
  const hasOption = Array.from(el.options || []).some(o => o.value === v)
  if (hasOption) {
    el.value = v
    el.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  }

  const opt = Array.from(el.options || []).find(o => (o.textContent || '').trim() === v)
  if (opt) {
    el.value = opt.value
    el.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  }

  return false
}

function normalizeNumberLike(value) {
  const text = String(value ?? '').trim()
  if (!text) return ''
  const m = text.match(/(\d[\d,]*)(\.\d+)?/)
  if (!m) return ''
  return (m[1] + (m[2] || '')).replace(/,/g, '')
}

function fillEbayForm(payload) {
  const title = String(payload?.title ?? '')
  const priceFormat = String(payload?.priceFormat ?? '')
  const price = normalizeNumberLike(payload?.price)
  const quantity = String(payload?.quantity ?? '')
  const shippingCost = String(payload?.shippingCost ?? '')
  const handlingTime = String(payload?.handlingTime ?? '')
  const itemLocation = String(payload?.itemLocation ?? '')
  const description = String(payload?.description ?? '')

  setInputValue($('s0-1-0-25-5-@TITLE-5-33-11-4-se-textbox'), title)
  setSelectValue($('s0-1-0-25-5-@PRICE-1-33-2-8-5-format'), priceFormat)
  setInputValue($('s0-1-0-25-5-@PRICE-1-33-2-14-3-2-se-textbox'), price)
  setInputValue($('s0-1-0-25-5-@PRICE-1-33-2-21-3-se-textbox'), quantity)
  setInputValue($('s0-1-0-25-5-@SHIPPING-0-33-6-3-5-36-8-se-textbox'), shippingCost)
  setSelectValue($('s0-1-0-25-5-@SHIPPING-0-33-handling-time-select'), handlingTime)

  const itemOriginSelect = $('s0-1-0-25-5-@SHIPPING-0-33-9-item-origin-country-of-origin')
  if (itemOriginSelect) {
    const byValueOk = setSelectValue(itemOriginSelect, itemLocation)
    if (!byValueOk) {
      const opt = Array.from(itemOriginSelect.options || []).find(o =>
        (o.textContent || '').trim().toLowerCase().includes(itemLocation.toLowerCase())
      )
      if (opt) setSelectValue(itemOriginSelect, opt.value)
    }
  }

  const descEl = $('s0-1-0-25-5-@DESCRIPTION-1-33-@rich-text-editor-rawEditor')
  if (descEl) {
    descEl.focus?.()
    descEl.innerHTML = description
    descEl.dispatchEvent(new Event('input', { bubbles: true }))
    descEl.dispatchEvent(new Event('change', { bubbles: true }))
  }
}

async function waitForId(id, timeoutMs = 15000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const el = document.getElementById(id)
    if (el) return el
    await new Promise(r => setTimeout(r, 200))
  }
  return null
}

async function fillEbayFormAsync(payload) {
  await waitForId('s0-1-0-25-5-@TITLE-5-33-11-4-se-textbox', 20000)
  fillEbayForm(payload)
  if (Array.isArray(payload?.photos) && payload.photos.length) {
    await uploadPhotos(payload.photos)
  }
  return true
}

globalThis.fillEbayForm = fillEbayForm
globalThis.fillEbayFormAsync = fillEbayFormAsync

async function uploadPhotos(photos) {
  const browseId = 's0-1-0-25-5-@PHOTOS-browse-btn'
  await waitForId(browseId, 20000)
  const browseEl = document.getElementById(browseId)

  let fileInput = null
  if (browseEl && browseEl.tagName === 'INPUT' && browseEl.type === 'file') {
    fileInput = browseEl
  } else {
    fileInput =
      browseEl?.querySelector?.('input[type="file"]') ||
      browseEl?.closest?.('label, div')?.querySelector?.('input[type="file"]') ||
      document.querySelector('input[type="file"]')
  }
  if (!fileInput) return false

  const list = Array.isArray(photos) ? photos : []
  const dt = new DataTransfer()
  for (const item of list) {
    const dataUrl = String(item?.dataUrl || '')
    if (!dataUrl.startsWith('data:')) continue
    const name = String(item?.name || 'photo.jpg')
    const blob = await (await fetch(dataUrl)).blob()
    const file = new File([blob], name, { type: blob.type || 'image/jpeg' })
    dt.items.add(file)
  }

  if (!dt.files.length) return false
  fileInput.files = dt.files
  fileInput.dispatchEvent(new Event('input', { bubbles: true }))
  fileInput.dispatchEvent(new Event('change', { bubbles: true }))
  await new Promise(r => setTimeout(r, 500))
  try {
    fileInput.value = ''
    fileInput.dispatchEvent(new Event('change', { bubbles: true }))
  } catch {}
  return true
}

globalThis.uploadPhotos = uploadPhotos

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'FILL_EBAY') return
  ;(async () => {
    try {
      await fillEbayFormAsync(message?.payload)
      sendResponse({ ok: true })
    } catch (e) {
      sendResponse({ ok: false, error: e instanceof Error ? e.message : 'Fill failed.' })
    }
  })()
  return true
})
