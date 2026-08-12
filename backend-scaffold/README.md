# Pexora backend

This service enables the server-powered tools in the main Pexora UI:
- Word/DOCX -> PDF (LibreOffice)
- PDF -> DOCX (LibreOffice)
- HTML -> PDF (Chromium)
- Protect / Unlock PDF (qpdf)

## Local
1. Install Node.js 20+ and the system binaries `libreoffice`, `qpdf`, and `chromium`.
2. `npm install`
3. Set `ALLOWED_ORIGIN=http://localhost:8787` and optionally `CHROMIUM_PATH`.
4. `npm start`
5. Serve the parent folder from a web server (or use the backend's static serving after copying the frontend files).

The frontend defaults to `http://localhost:8787` for backend requests. Set `localStorage.pexora-backend-url` if your API lives elsewhere.

For production, put the conversion service behind HTTPS, run it as an unprivileged user, isolate document converters, enforce CPU/memory/time limits, and add scheduled cleanup.
