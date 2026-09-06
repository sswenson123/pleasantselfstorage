# Hosted preview build

Assembles a single self-contained page from the real repo files — `css/styles.css`,
`move-out.html`, `js/move-out.js`, `images/logo-mark.svg` — so the preview is the
same page and the same wizard, not a retyped copy.

```bash
node preview/build-artifact.mjs   # -> preview-artifact.html
node preview/wrap.mjs             # -> preview-wrapped.html (adds the host's <head>, for local testing)
node e2e/artifact.spec.mjs        # 6 checks against the wrapped page
```

`preview-artifact.html` is what gets published as a hosted preview. It swaps only
the wizard's transport: instead of the Cloudflare Worker it reads and writes the
hosted page's own store, so the flow can be exercised on a phone before any
backend is deployed.

**Differences from the real backend, on purpose:**

| | Hosted preview | Preview Worker |
|---|---|---|
| Move-out timestamp | this device's clock | the server's clock |
| Photos | re-compressed to ~1100px to fit the store's per-document limit | full compressed upload to R2 |
| Records | the page's own store | D1, stamped `environment = PREVIEW` |
| SMS outbox | not recorded | a PENDING row per submission |
| Staff view | the TEST RECORDS panel on the page | `/admin` behind Cloudflare Access |

The generated files are build output and are not committed.
