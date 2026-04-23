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
  return true
}

globalThis.fillEbayForm = fillEbayForm
globalThis.fillEbayFormAsync = fillEbayFormAsync

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
