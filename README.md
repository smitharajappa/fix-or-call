# Fix or Call

A single-page app for people with little to no repair experience. Describe what's broken around the house, or attach a photo, and it returns:

- A plain-English diagnosis (the technical part name appears once, in parentheses, never assumed knowledge)
- A verdict — **DIY-safe**, **doable with care**, or **call a pro** (conservative by design: gas, breaker-panel, structural, and roofing issues always route to a pro)
- For DIY: numbered steps, a materials list in hardware-aisle language, and a time/cost estimate
- For "call a pro": a one-line script for the phone call and a realistic price range

**Live app:** https://claude.ai/artifact/UquqvF1S2waA3UEyFUWaTL

## How it works

`index.html` is the entire app — no backend, no build step, no API key. It runs on [Claude's artifact runtime](https://claude.ai), which exposes a `sample` capability the page uses to call Claude directly with the user's description and/or photo, asking for a structured JSON diagnosis that the page renders as a "repair ticket." Everything (styling, layout, prompt construction, JSON parsing) lives in that one file.

Opened outside a Claude artifact viewer (e.g. this raw file on GitHub Pages, or a plain `file://` open), the `window.claude` API doesn't exist at all — the app detects that and disables the "Diagnose" button gracefully instead of throwing.

## Why this exists

Built for a graduate AI-in-Business assignment: ship something small, working, and aimed at a customer currently ignored by existing tools. See the accompanying memo for the full case.
