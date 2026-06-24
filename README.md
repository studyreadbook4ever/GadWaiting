# GadWaiting

download this and change public/house-ads/~~ to show the ads that you want, and change link of src/gadwaiting.config.json's "href": "https://eff0rtchung.kr/" to change the link.

**GadWaiting** is a tiny TypeScript library for the waiting period before a web ad program is approved or reliably serving ads. When the ad provider script is unavailable, times out, or reports an unfilled slot, GadWaiting shows your own local image ad in the same ad slot.

Official Korean service name: **개드웨이팅**.

Use it when you want the ad area on your site to stay useful while approval, review, fill-rate, or temporary provider issues are still in progress. The default local creative links to `https://eff0rtchung.kr/`, but every slot can point anywhere you choose.

## What It Does

- Keeps a fixed ad slot size so the page does not jump.
- Checks the provider script every 60 seconds by default.
- Shows a local fallback creative when the provider is not ready.
- Switches back to the provider slot when the check becomes healthy again.
- Supports common web ad sizes out of the box: `300x250`, `336x280`, `728x90`, `970x90`, `970x250`, `320x50`, `320x100`, `300x600`, and `160x600`.

## Quick Start

```bash
npm run doctor
npm run demo
```

Open the demo:

```text
http://127.0.0.1:4173/?mock=down&fast=1
http://127.0.0.1:4173/?mock=filled&fast=1
http://127.0.0.1:4173/?mock=unfilled&fast=1
```

The repository also includes a static `index.html` demo that can run from static hosting or GitHub Pages.

## Configure

Edit `gadwaiting.config.json`.

```json
{
  "check": {
    "intervalMs": 60000,
    "timeoutMs": 2500
  },
  "slots": [
    {
      "id": "sidebar-rectangle",
      "mount": "#ad-sidebar",
      "size": { "width": 300, "height": 250 },
      "provider": {
        "client": "your-publisher-id",
        "slot": "your-slot-id",
        "format": "auto",
        "fullWidthResponsive": true
      },
      "fallback": {
        "href": "https://eff0rtchung.kr/",
        "label": "Advertisement",
        "alt": "GadWaiting fallback advertisement",
        "assets": [
          { "src": "/house-ads/local-300x250.svg", "width": 300, "height": 250 },
          { "src": "/house-ads/local-336x280.svg", "width": 336, "height": 280 },
          { "src": "/house-ads/local-728x90.svg", "width": 728, "height": 90 },
          { "src": "/house-ads/local-970x90.svg", "width": 970, "height": 90 },
          { "src": "/house-ads/local-970x250.svg", "width": 970, "height": 250 },
          { "src": "/house-ads/local-320x50.svg", "width": 320, "height": 50 },
          { "src": "/house-ads/local-320x100.svg", "width": 320, "height": 100 },
          { "src": "/house-ads/local-300x600.svg", "width": 300, "height": 600 },
          { "src": "/house-ads/local-160x600.svg", "width": 160, "height": 600 }
        ]
      }
    }
  ]
}
```

Run the checker after replacing assets:

```bash
npm run doctor
```

It prints the exact asset checklist your site expects.

## Use In A Page

```bash
npm run build
```

```html
<div id="ad-sidebar"></div>
<script type="module">
  import { mountGadWaiting } from "/dist/gadwaiting.js";

  const config = await fetch("/gadwaiting.config.json").then((response) => response.json());
  mountGadWaiting(config);
</script>
```

## AI-Native Setup Prompt

Paste this into your coding agent after copying the project into a site:

```text
Wire GadWaiting into this page. Add stable ad mount elements, keep the layout from shifting, replace the fallback images under public/house-ads with project-branded creatives, set fallback.href to the preferred landing page, then run npm run doctor and fix every warning.
```

Useful follow-up prompt:

```text
Create fallback creatives for these sizes: 300x250, 336x280, 728x90, 970x90, 970x250, 320x50, 320x100, 300x600, 160x600. Keep them readable, avoid misleading clickbait, and label the slot as Advertisement.
```

## Practical Notes

- Keep `fallback.label` as `Advertisement` or another clear ad label.
- Do not use text that tricks people into clicking.
- Do not make the local creative look like system UI, site navigation, or editorial content.
- If you use external image URLs, make sure they are stable and fast.
- If your ad provider uses a different script URL, set `provider.scriptUrl` or `check.endpoint`.
- For static hosting, commit `public/index.html`, `public/house-ads/*`, `dist/gadwaiting.js`, and `gadwaiting.config.json`.
- For GitHub Pages, serve the repository root and open `index.html`.

## Commands

```bash
npm run init      # create default config and sample creatives
npm run doctor    # validate local creative files and dimensions
npm run probe     # check a provider endpoint for HTTP 200
npm run build     # emit dist/gadwaiting.js
npm run demo      # run the local test page
```

## License

Released under the Unlicense. See `LICENSE`.
