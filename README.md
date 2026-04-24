## AliExpress → eBay Mock Page Chrome Extension

Scrapes product detail from the active AliExpress tab and fills the listing form on:
`https://ebay-mock-page.vercel.app/`

### How it works

- If the current tab URL is NOT the fixed listing URL:
  - Scrapes product detail from the current tab (does not fetch hrefs).
- If the current tab URL IS the fixed listing URL:
  - Auto-scrolls the page, collects product hrefs (limited by `HREF_LIMIT`), then visits each href in the same tab and scrapes its product detail.
- Opens (or focuses) the eBay mock page, fills the form, uploads photos, then clicks “List It” (`list-it-btn`).

### Install (Developer Mode)

1. Open Chrome → `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select this folder:
   `Chrome-extension-for-auto-workflow-aliexpress-to-ebay`

### Usage

1. Open an AliExpress product page (or the fixed listing page) in the active tab.
2. Click the extension icon.
3. Click **Start**.
4. The extension will fill the eBay mock page automatically.

### Configuration


- `TARGET_URL`: the fixed listing URL used to decide whether to fetch hrefs or scrape the current tab
- `HREF_LIMIT`: how many hrefs to collect from the listing page
- `EBAY_LISTING_URL`: the eBay mock page URL
- `JPY_TO_USD_RATE`: conversion rate used when currency is JPY/yen/円

### Notes

- This is a Manifest V3 extension (service worker background).
- Photo upload uses in-memory fetch of image URLs and uploads via the page’s file input.
