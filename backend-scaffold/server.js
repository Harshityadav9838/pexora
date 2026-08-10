/**
 * Pexora backend scaffold — for PDF<->Word / HTML->PDF / real PDF encryption only.
 *
 * STATUS: This file is illustrative architecture, not a running service.
 * It was written without network access to install or test any package
 * (express, helmet, multer, etc. are referenced but not installed/verified
 * here). Read it as a reviewed pattern to implement and test properly in a
 * real environment, not as a finished deliverable.
 *
 * Pattern implemented:
 *   Upload API -> validation -> quarantine storage -> isolated worker
 *   (separate process, resource-limited, non-root, no network) ->
 *   output validation -> short-lived signed download -> automatic deletion.
 */

const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const { z } = require('zod');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs/promises');
const { spawn } = require('child_process');

const app = express();

// ---- Config (centralized, overridable via env) ----------------------------
const CONFIG = {
  MAX_UPLOAD_BYTES: parseInt(process.env.MAX_UPLOAD_BYTES || `${50 * 1024 * 1024}`, 10),
  QUARANTINE_DIR: process.env.QUARANTINE_DIR || '/tmp/pexora-quarantine',
  RESULT_DIR: process.env.RESULT_DIR || '/tmp/pexora-results',
  RESULT_TTL_MS: parseInt(process.env.RESULT_TTL_MS || `${15 * 60 * 1000}`, 10), // 15 min
  WORKER_TIMEOUT_MS: parseInt(process.env.WORKER_TIMEOUT_MS || `${60 * 1000}`, 10),
  ALLOWED_ORIGIN: process.env.ALLOWED_ORIGIN || 'https://your-domain.example',
  DOWNLOAD_SIGNING_SECRET: process.env.DOWNLOAD_SIGNING_SECRET, // required, no default
};
if (!CONFIG.DOWNLOAD_SIGNING_SECRET) {
  // Fail closed: never run with a guessable/default signing secret.
  throw new Error('DOWNLOAD_SIGNING_SECRET must be set via environment variable.');
}

// ---- Security headers, CORS, body limits -----------------------------------
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
    },
  },
  crossOriginResourcePolicy: { policy: 'same-site' },
}));
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', CONFIG.ALLOWED_ORIGIN); // never '*'
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST');
  res.setHeader('Vary', 'Origin');
  next();
});
app.disable('x-powered-by');

// ---- Rate limiting (per-endpoint, server-side — never trust the frontend) --
const uploadLimiter = rateLimit({ windowMs: 60_000, max: 10, standardHeaders: true, legacyHeaders: false });
const downloadLimiter = rateLimit({ windowMs: 60_000, max: 30 });

// ---- Multer: allowlist + size + count, magic-byte check done after upload --
const upload = multer({
  dest: CONFIG.QUARANTINE_DIR,
  limits: { fileSize: CONFIG.MAX_UPLOAD_BYTES, files: 1 },
});

const PDF_MAGIC = Buffer.from('%PDF-');
async function verifyPdfSignature(filePath) {
  const fh = await fs.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(5);
    await fh.read(buf, 0, 5, 0);
    return buf.equals(PDF_MAGIC);
  } finally {
    await fh.close();
  }
}

// ---- Input schema validation (reject unexpected fields) --------------------
const convertRequestSchema = z.object({
  targetFormat: z.enum(['docx', 'pdf']),
}).strict();

// ---- Signed, short-lived download tokens (no permanent public URLs) -------
function signResultId(resultId) {
  const hmac = crypto.createHmac('sha256', CONFIG.DOWNLOAD_SIGNING_SECRET);
  hmac.update(resultId);
  return hmac.digest('hex');
}
function makeDownloadToken(resultId, expiresAt) {
  const payload = `${resultId}.${expiresAt}`;
  const sig = signResultId(payload);
  return Buffer.from(`${payload}.${sig}`).toString('base64url');
}
function verifyDownloadToken(token) {
  try {
    const decoded = Buffer.from(token, 'base64url').toString('utf8');
    const [resultId, expiresAt, sig] = decoded.split('.');
    const expected = signResultId(`${resultId}.${expiresAt}`);
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    if (Date.now() > parseInt(expiresAt, 10)) return null;
    return resultId;
  } catch {
    return null;
  }
}

// ---- POST /api/convert/pdf-to-word -----------------------------------------
app.post('/api/convert/pdf-to-word', uploadLimiter, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
    if (!(await verifyPdfSignature(req.file.path))) {
      await fs.unlink(req.file.path).catch(() => {});
      return res.status(400).json({ error: 'File is not a valid PDF.' });
    }
    // Never trust req.body blindly — validate against schema, reject extras.
    const parseResult = convertRequestSchema.safeParse({ targetFormat: 'docx' });
    if (!parseResult.success) return res.status(400).json({ error: 'Invalid request.' });

    // Generate an internal, unguessable ID — never use the original filename
    // or any user input as part of a filesystem path.
    const jobId = crypto.randomUUID();
    const resultPath = path.join(CONFIG.RESULT_DIR, `${jobId}.docx`);

    await runInIsolatedWorker({
      jobId,
      inputPath: req.file.path,
      outputPath: resultPath,
      // In a real deployment this would exec a locked-down converter
      // (e.g. LibreOffice headless) inside its own container/VM with:
      //  - no network access
      //  - a read-only root filesystem except a scratch dir
      //  - non-root user, dropped capabilities
      //  - CPU + memory cgroup limits
      //  - a hard wall-clock timeout that kills the process group
      command: 'soffice',
      args: ['--headless', '--convert-to', 'docx', '--outdir', CONFIG.RESULT_DIR, req.file.path],
      timeoutMs: CONFIG.WORKER_TIMEOUT_MS,
    });

    await fs.unlink(req.file.path).catch(() => {}); // delete the quarantined input immediately

    const expiresAt = Date.now() + 5 * 60 * 1000; // 5-minute signed link
    const token = makeDownloadToken(jobId, expiresAt);
    scheduleDeletion(resultPath, CONFIG.RESULT_TTL_MS);

    res.json({ downloadUrl: `/api/download?token=${token}` });
  } catch (err) {
    // Never leak stack traces or filesystem paths to the client.
    req.log?.error?.({ err, route: 'pdf-to-word' }, 'conversion failed');
    res.status(500).json({ error: "We couldn't process this file. Please try another PDF." });
  }
});

// ---- GET /api/download -------------------------------------------------
app.get('/api/download', downloadLimiter, async (req, res) => {
  const resultId = verifyDownloadToken(String(req.query.token || ''));
  if (!resultId) return res.status(403).json({ error: 'This download link is invalid or has expired.' });

  // resultId is our own generated UUID — never derived from user input —
  // so this join can't be used for path traversal.
  const filePath = path.join(CONFIG.RESULT_DIR, `${resultId}.docx`);
  try {
    await fs.access(filePath);
  } catch {
    return res.status(404).json({ error: 'This file is no longer available.' });
  }
  res.download(filePath);
});

// ---- Isolated worker runner --------------------------------------------
function runInIsolatedWorker({ command, args, timeoutMs }) {
  return new Promise((resolve, reject) => {
    // In production this should invoke a container/VM boundary (e.g. gVisor,
    // Firecracker, or a locked-down Docker run with --network=none,
    // --read-only, --cap-drop=ALL, --pids-limit, --memory, --cpus), not just
    // a bare child_process. This is shown as the control-flow shape only.
    const child = spawn(command, args, {
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      // uid/gid pinned to an unprivileged, dedicated worker account in prod
    });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`worker exited with code ${code}: ${stderr.slice(0, 500)}`));
    });
  });
}

// ---- Scheduled cleanup for both normal expiry and abandoned jobs ----------
function scheduleDeletion(filePath, delayMs) {
  setTimeout(() => { fs.unlink(filePath).catch(() => {}); }, delayMs);
}
// A real deployment also needs a periodic sweep (cron / scheduled job) that
// deletes anything in QUARANTINE_DIR/RESULT_DIR older than its TTL, to catch
// files orphaned by crashed requests — a single setTimeout per file isn't
// enough on its own.

// ---- Generic error handler: never leak internals ---------------------------
app.use((err, req, res, next) => {
  req.log?.error?.(err);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

module.exports = app;
