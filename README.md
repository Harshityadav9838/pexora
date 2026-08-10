# Pexora — what this build actually is

This was produced in a single chat session with **no ability to run `npm install`,
no outbound network access from the build environment, and no server to deploy
to.** Rather than hand you a Vite project with imaginary dependencies and a fake
"deployed" claim, this is a single self-contained web app (`index.html` +
`app.js`) that loads two well-known libraries from a CDN at page load and does
**real, working** PDF processing in the browser. Open `index.html` in any
browser, or host these two files (plus nothing else) anywhere — Vercel, GitHub
Pages, S3, whatever — and every non-"requires backend" tool works exactly as
shipped.

## What's real

- `pdf-lib` (document editing) and `pdf.js` (rendering/text extraction), both
  loaded from cdnjs, both real, both doing the actual work.
- File validation checks the **true file signature** (magic bytes), not the
  filename or the browser-supplied MIME type — see `validateFile()` in `app.js`.
- Organize, Merge, Split, Images→PDF, PDF→Image, PDF→Text, Watermark, Page
  Numbers, Metadata edit/strip, and Compress (structural re-save) all run
  client-side and produce real output files you can open.
- Split and PDF→Image bundle multiple outputs into a genuine (if
  uncompressed/"store"-mode) ZIP file, hand-written in `app.js` — no
  fabricated download links.
- Because these tools never send your file anywhere, most of the server-side
  attack surface the original brief worries about (upload validation bypass,
  storage IDOR, SSRF via a renderer, signed-URL leakage, zip bombs from
  *processing* zips) simply doesn't exist for them — there's no server in the
  loop.

## What's honestly NOT implemented, and why

- **PDF ↔ Word, HTML → PDF, Protect/Unlock with real PDF encryption** — these
  need a server-side rendering/encryption engine that doesn't exist in a
  browser (or, for encryption, isn't supported by pdf-lib). The UI disables
  these with a plain explanation instead of pretending to convert. See
  `backend-scaffold/` for how the server side would be built.
- **Actual deployment** — nothing here has been deployed or given a live URL.
  You'd deploy `index.html`/`app.js` as static files, and separately deploy
  the backend scaffold if you want the four tools above.
- **Rate limiting, auth, a database, CAPTCHA, signed download URLs, security
  headers, CORS config** — all of this only matters once there's a server
  accepting requests. None of the tools in this build hit a server, so there's
  nothing to rate-limit yet. `backend-scaffold/server.js` shows the pattern
  (validation → quarantine → isolated worker → short-lived signed download →
  auto-delete) you'd wire real middleware into.
- **Automated test suite / `npm run build`** — there is no `package.json`
  here; this isn't a bundled project, so there's no build step to run. If you
  want a real Vite/React project structure, tests, CI, etc., that's a
  follow-up task with actual package installation, which this environment
  can't do.
- **Compress** genuinely re-saves with optimized object streams (real,
  measurable size reduction on many files) but does **not** re-encode
  embedded images at lower quality, which is the main lever for shrinking
  large scanned PDFs. The tool says so in the UI rather than overstating the
  result.

## Security notes specific to what's shipped

- No `eval`, no `innerHTML` with user-controlled data — filenames are
  rendered via `textContent` and passed through `sanitizeFilenameForDisplay()`
  first as a second layer of defense.
- Files are validated against an **allowlist** of magic-byte signatures
  (`SIGNATURES` in `app.js`), never a blacklist, and never trusted by
  extension or reported MIME type.
- Size and file-count caps (`MAX_FILE_BYTES`, `MAX_FILES`) are centralized
  constants, not scattered magic numbers.
- `localStorage` is used only for the light/dark theme preference — never for
  file contents or anything sensitive.
- The one place this app touches the network at runtime is the two `<script>`
  tags loading pdf-lib/pdf.js from cdnjs. If you're deploying this for real,
  consider vendoring those files yourself (with subresource integrity hashes)
  instead of trusting a CDN at runtime.

## If you want the full 50-point spec built for real

That's a multi-week engineering project (server infra, isolated workers,
queueing, auth, a database, deployment pipeline, security testing) — not
something any single chat response, from any tool, can actually stand up and
verify. Treat this build as the honest client-side slice plus a reviewed
architecture doc for the rest, and bring the backend scaffold to an
environment with real infrastructure (and package installation) to build out
and test properly.
