const express = require('express')
const puppeteer = require('puppeteer')

function isHttpUrl(url) {
  if (!url) return false
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

async function scrapeHrefs(targetUrl) {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })

  try {
    const page = await browser.newPage()
    await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 60000 })

    await page.waitForSelector('a._3mPKP', { timeout: 15000 }).catch(() => {})

    const matches = await page.evaluate(() => {
      const anchors = Array.from(document.querySelectorAll('a._3mPKP'))
      return anchors.map(a => ({
        href: a.href || '',
        text: (a.textContent || '').trim(),
      }))
    })

    const finalUrl = page.url()
    const hrefs = (Array.isArray(matches) ? matches : []).map(m => m?.href).filter(Boolean)
    const uniqueHrefs = Array.from(new Set(hrefs)).filter(Boolean)
    const aTags = (Array.isArray(matches) ? matches : []).filter(m => m && typeof m.href === 'string')
    return { finalUrl, hrefs: uniqueHrefs, aTags }
  } finally {
    await browser.close()
  }
}

const app = express()

app.get('/hrefs', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  const targetUrl = typeof req.query.url === 'string' ? req.query.url.trim() : ''
  if (!isHttpUrl(targetUrl)) {
    res.status(400).json({ ok: false, error: 'Please provide a valid http(s) URL.' })
    return
  }

  try {
    const { finalUrl, hrefs, aTags } = await scrapeHrefs(targetUrl)
    res.json({ ok: true, finalUrl, hrefs, aTags })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Scrape failed.'
    res.status(500).json({ ok: false, error: msg })
  }
})

const port = Number(process.env.PORT || 3007)
app.listen(port, '127.0.0.1', () => {
  process.stdout.write(`puppeteer_server listening on http://127.0.0.1:${port}\n`)
})
