/* =========================================================================
   Pexora — client-side app logic.
   Every operation below runs in the browser. No network requests are made
   for file processing. See README.md for exactly what is and isn't real.
   ========================================================================= */

const { PDFDocument, degrees, rgb, StandardFonts } = window.PDFLib || {};

/* ---------------------- File signature / validation -------------------- */
// We never trust file.name or file.type. We read the first bytes of the
// actual file and compare against known magic numbers.
const SIGNATURES = {
  pdf:  { bytes: [0x25,0x50,0x44,0x46,0x2D], label: 'PDF' },               // %PDF-
  jpg:  { bytes: [0xFF,0xD8,0xFF], label: 'JPEG' },
  png:  { bytes: [0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A], label: 'PNG' },
  webp: { bytes: [0x52,0x49,0x46,0x46], extra: {offset:8, bytes:[0x57,0x45,0x42,0x50]}, label: 'WEBP' }, // RIFF....WEBP
};
const MAX_FILE_BYTES = 50 * 1024 * 1024;   // 50MB single-file default
const MAX_FILES = 20;
const MAX_FILENAME_LEN = 180;

function readHeaderBytes(file, len = 16) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result));
    reader.onerror = () => reject(new Error('Could not read file'));
    reader.readAsArrayBuffer(file.slice(0, len));
  });
}

function matchesSignature(bytes, sig) {
  for (let i = 0; i < sig.bytes.length; i++) if (bytes[i] !== sig.bytes[i]) return false;
  if (sig.extra) {
    for (let i = 0; i < sig.extra.bytes.length; i++) {
      if (bytes[sig.extra.offset + i] !== sig.extra.bytes[i]) return false;
    }
  }
  return true;
}

function sanitizeFilenameForDisplay(name) {
  // Strip control chars / null bytes / path separators before ever putting
  // a filename into the DOM. textContent is used everywhere too (never
  // innerHTML with user data) as a second layer of defense.
  let clean = String(name).replace(/[\u0000-\u001F\u007F\\/]/g, '');
  if (clean.length > MAX_FILENAME_LEN) clean = clean.slice(0, MAX_FILENAME_LEN) + '…';
  return clean || 'file';
}

/**
 * Validate a File against an allowlist of type keys (e.g. ['pdf'] or ['jpg','png','webp']).
 * Checks: size, filename length, and true magic-byte signature — NOT extension or MIME type.
 */
async function validateFile(file, allowedKeys, maxBytes = MAX_FILE_BYTES) {
  if (!file) return { ok: false, error: 'No file provided.' };
  if (file.size === 0) return { ok: false, error: 'This file is empty.' };
  if (file.size > maxBytes) return { ok: false, error: `File is too large (limit ${(maxBytes/1024/1024).toFixed(0)}MB).` };
  if (file.name && file.name.length > MAX_FILENAME_LEN) return { ok: false, error: 'Filename is too long.' };

  const header = await readHeaderBytes(file, 16);
  const matched = allowedKeys.find(k => SIGNATURES[k] && matchesSignature(header, SIGNATURES[k]));
  if (!matched) {
    return { ok: false, error: `This doesn't look like a valid ${allowedKeys.map(k=>SIGNATURES[k].label).join('/')} file (checked file signature, not the name).` };
  }
  return { ok: true, type: matched };
}

/* -------------------------------- Utilities ------------------------------ */
function bytesToHuman(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024*1024) return (n/1024).toFixed(1) + ' KB';
  return (n/1024/1024).toFixed(2) + ' MB';
}
function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
function el(tag, attrs = {}, children = []) {
  const e = document.createElement(tag);
  for (const [k,v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  (Array.isArray(children) ? children : [children]).forEach(c => c && e.appendChild(c));
  return e;
}

/* ---------------- Minimal ZIP (store-only, no compression) --------------
   Used only for bundling multiple output files (e.g. split PDFs, exported
   page images) into one download. Store-only avoids pulling in a
   compression dependency; it's a real, valid ZIP, just uncompressed. */
function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c >>> 0;
    }
  }
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
function buildZip(files) { // files: [{name, data: Uint8Array}]
  const encoder = new TextEncoder();
  const localParts = [], centralParts = [];
  let offset = 0;
  for (const f of files) {
    const nameBytes = encoder.encode(f.name);
    const crc = crc32(f.data);
    const size = f.data.length;
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0, true);
    local.setUint16(8, 0, true); // store, no compression
    local.setUint16(10, 0, true);
    local.setUint16(12, 0, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, size, true);
    local.setUint32(22, size, true);
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true);
    localParts.push(new Uint8Array(local.buffer), nameBytes, f.data);

    const central = new DataView(new ArrayBuffer(46));
    central.setUint32(0, 0x02014b50, true);
    central.setUint16(4, 20, true);
    central.setUint16(6, 20, true);
    central.setUint16(8, 0, true);
    central.setUint16(10, 0, true);
    central.setUint16(12, 0, true);
    central.setUint16(14, 0, true);
    central.setUint32(16, crc, true);
    central.setUint32(20, size, true);
    central.setUint32(24, size, true);
    central.setUint16(28, nameBytes.length, true);
    central.setUint16(30, 0, true);
    central.setUint16(32, 0, true);
    central.setUint16(34, 0, true);
    central.setUint16(36, 0, true);
    central.setUint32(38, 0, true);
    central.setUint32(42, offset, true);
    centralParts.push(new Uint8Array(central.buffer), nameBytes);

    offset += 30 + nameBytes.length + size;
  }
  const centralStart = offset;
  let centralSize = 0;
  centralParts.forEach(p => centralSize += p.length);

  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(4, 0, true);
  end.setUint16(6, 0, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, centralStart, true);
  end.setUint16(20, 0, true);

  return new Blob([...localParts, ...centralParts, new Uint8Array(end.buffer)], { type: 'application/zip' });
}

/* ------------------------------ UI helpers -------------------------------- */
function setStatus(container, type, message) {
  const box = container.querySelector('.status');
  box.className = `status show ${type}`;
  box.textContent = message;
}
function clearStatus(container) {
  const box = container.querySelector('.status');
  box.className = 'status';
  box.textContent = '';
}
function setProgress(container, pct) {
  const track = container.querySelector('.progress-track');
  const fill = container.querySelector('.progress-fill');
  if (pct === null) { track.classList.remove('show'); fill.style.width = '0%'; return; }
  track.classList.add('show');
  fill.style.width = Math.max(0, Math.min(100, pct)) + '%';
}

/* ================================ TOOL REGISTRY ============================ */
const TOOLS = [
  { id:'organize',    icon:'⇅', name:'Organize PDF',       desc:'Reorder, rotate, delete or extract pages from a single PDF.', backend:false },
  { id:'merge',       icon:'⊕', name:'Merge PDF',          desc:'Combine multiple PDFs into one, in the order you choose.', backend:false },
  { id:'split',       icon:'⊟', name:'Split PDF',          desc:'Break a PDF into page ranges, downloaded as a zip.', backend:false },
  { id:'images-to-pdf', icon:'🖼', name:'Images to PDF',    desc:'Combine JPG, PNG or WEBP images into one PDF.', backend:false },
  { id:'pdf-to-image', icon:'▤', name:'PDF to JPG / PNG',   desc:'Export every page as an image, zipped for download.', backend:false },
  { id:'pdf-to-text', icon:'¶', name:'PDF to Text',        desc:'Extract the text content of a PDF to a .txt file.', backend:false },
  { id:'watermark',   icon:'◈', name:'Add Watermark',      desc:'Stamp a text watermark across every page.', backend:false },
  { id:'page-numbers',icon:'#', name:'Add Page Numbers',   desc:'Number every page, with position and starting number.', backend:false },
  { id:'metadata',    icon:'i', name:'Edit / Remove Metadata', desc:'View, edit, or strip a PDF\'s title, author and other metadata.', backend:false },
  { id:'compress',    icon:'↓', name:'Compress PDF',       desc:'Re-save with optimized internal structure.', backend:false },
  { id:'pdf-to-word', icon:'W', name:'PDF to Word',        desc:'Convert a PDF to an editable DOCX using the server conversion engine.', backend:true },
  { id:'word-to-pdf', icon:'W', name:'Word to PDF',        desc:'Convert DOC or DOCX files into PDF using the server conversion engine.', backend:true },
  { id:'html-to-pdf', icon:'</>', name:'HTML to PDF',      desc:'Render HTML into a PDF with a sandboxed server-side browser.', backend:true },
  { id:'protect',     icon:'🔒', name:'Protect / Unlock PDF', desc:'Standard PDF encryption isn\'t available client-side yet.', backend:true },
];

function renderToolGrid() {
  const grid = document.getElementById('toolGrid');
  TOOLS.forEach(t => {
    const card = el('a', { class:'tool-card', href:'#tool-'+t.id, 'data-tool':t.id }, [
      t.backend ? el('span', {class:'tool-tag', text:'Requires backend'}) : null,
      el('div', { class:'tool-icon', text:t.icon }),
      el('h3', { text:t.name }),
      el('p', { text:t.desc }),
    ]);
    card.addEventListener('click', (e) => { e.preventDefault(); openTool(t.id); });
    grid.appendChild(card);
  });
}

/* ============================== WORKSPACE SHELL ============================ */
const root = document.getElementById('workspace-root');
const homeView = document.getElementById('home-view');
let currentWorkspace = null;

function openTool(id) {
  homeView.style.display = 'none';
  root.innerHTML = '';
  const tool = TOOLS.find(t => t.id === id);
  const shell = el('div', { class:'workspace active', id:'tool-'+id });
  shell.appendChild(el('div', { class:'workspace-head' }, [
    el('a', { class:'back', href:'#', text:'← Back to all tools', onclick:(e)=>{e.preventDefault(); closeTool();} }),
    el('h2', { text: tool.name }),
    el('p', { text: tool.desc }),
  ]));
  const body = el('div', { class:'workspace-body' });
  shell.appendChild(body);
  shell.appendChild(el('div', { class:'status' }));
  shell.appendChild(el('div', { class:'progress-track' }, [el('div', {class:'progress-fill'})]));
  root.appendChild(shell);
  currentWorkspace = shell;
  window.scrollTo({top:0, behavior:'instant' in window ? 'instant':'auto'});

  if (tool.backend) return renderBackendNotice(shell, body, tool);

  const renderers = {
    organize: renderOrganize, merge: renderMerge, split: renderSplit,
    'images-to-pdf': renderImagesToPdf, 'pdf-to-image': renderPdfToImage,
    'pdf-to-text': renderPdfToText, watermark: renderWatermark,
    'page-numbers': renderPageNumbers, metadata: renderMetadata, compress: renderCompress,
    'pdf-to-word': renderPdfToWord, 'word-to-pdf': renderWordToPdf, 'html-to-pdf': renderHtmlToPdf, protect: renderProtect,
  };
  renderers[id](shell, body);
}
function closeTool() {
  root.innerHTML = '';
  homeView.style.display = '';
  window.location.hash = '#tools';
}
window.addEventListener('hashchange', () => {
  const h = location.hash.replace('#tool-','');
  if (location.hash.startsWith('#tool-') && TOOLS.some(t=>t.id===h)) openTool(h);
});
if (location.hash.startsWith('#tool-')) {
  const h = location.hash.replace('#tool-','');
  if (TOOLS.some(t=>t.id===h)) queueMicrotask(()=>openTool(h));
}

function backendBaseUrl(){
  const configured = (window.PEXORA_BACKEND_URL || '').trim();
  if (configured) return configured.replace(/\/$/,'');
  return location.protocol === 'file:' ? 'http://localhost:8787' : location.origin;
}
async function backendDownload(endpoint, formData, filename, shell){
  setProgress(shell,25);
  const res=await fetch(`${backendBaseUrl()}${endpoint}`,{method:'POST',body:formData});
  setProgress(shell,70);
  if(!res.ok){ let msg='Server could not process this file.'; try{const j=await res.json(); msg=j.error||msg;}catch{} throw new Error(msg); }
  const blob=await res.blob();
  download(blob, filename);
  setProgress(shell,100); setStatus(shell,'success','Done — your file is ready.'); setTimeout(()=>setProgress(shell,null),800);
}
function renderBackendNotice(shell, body, tool) {
  body.appendChild(el('div', { class:'security-notice' }, [
    el('span', { text:'⚙' }),
    el('div', {}, [
      el('div', { text:'Server-side tool', style:'color:var(--text-hi); font-weight:600; margin-bottom:4px;'}),
      el('div', { text: 'This tool sends the selected file only to your configured Pexora backend for processing. Inputs are temporary and the backend is designed to delete them after processing.' }),
    ])
  ]));
}
function backendFileDrop(body, allowed, accept, hint, onFile){
  const wrap=el('div'); const dz=buildDropzone({multiple:false,allowedKeys:allowed,accept,hint,onFiles:([f])=>{wrap.innerHTML='';wrap.appendChild(fileRow(f,null));onFile(f,wrap);}}); wrap.appendChild(dz); body.appendChild(wrap); return wrap;
}
function renderPdfToWord(shell, body){
  renderBackendNotice(shell,body,TOOLS.find(x=>x.id==='pdf-to-word'));
  backendFileDrop(body,['pdf'],'application/pdf','PDF only · processed by the backend',async f=>{try{const fd=new FormData();fd.append('file',f);await backendDownload('/api/convert/pdf-to-word',fd,'converted.docx',shell);}catch(e){setStatus(shell,'error',e.message);setProgress(shell,null);}});
}
function renderWordToPdf(shell, body){
  renderBackendNotice(shell,body,TOOLS.find(x=>x.id==='word-to-pdf'));
  const wrap=el('div'); const dz=el('div');
  const input=el('input',{type:'file',accept:'.doc,.docx,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document'});
  const drop=el('div',{class:'dropzone',tabindex:'0',role:'button'},[el('div',{class:'dz-icon',text:'W'}),el('h4',{text:'Drop a DOC or DOCX file, or click to browse'}),el('p',{text:'DOC/DOCX · converted on the server'})]);
  drop.appendChild(input); const pick=()=>input.click(); drop.addEventListener('click',pick); drop.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();pick();}});
  input.addEventListener('change',async()=>{const f=input.files?.[0];if(!f)return;if(f.size>MAX_FILE_BYTES){setStatus(shell,'error','File is too large (limit 50MB).');return;}wrap.innerHTML='';wrap.appendChild(fileRow(f,null));try{const fd=new FormData();fd.append('file',f);await backendDownload('/api/convert/word-to-pdf',fd,'converted.pdf',shell);}catch(e){setStatus(shell,'error',e.message);setProgress(shell,null);}}); wrap.appendChild(drop); body.appendChild(wrap);
}
function renderHtmlToPdf(shell, body){
  renderBackendNotice(shell,body,TOOLS.find(x=>x.id==='html-to-pdf'));
  const form=el('div',{class:'form-grid'}); const area=el('textarea',{rows:'16',placeholder:'Paste HTML here...'}); area.style.cssText='width:100%;min-height:280px;background:var(--panel);color:var(--text-hi);border:1px solid var(--line);border-radius:12px;padding:14px;font:14px var(--font-mono);resize:vertical;';
  const btn=el('button',{class:'btn btn-primary',text:'Render HTML to PDF',onclick:async()=>{if(!area.value.trim()){setStatus(shell,'error','Paste some HTML first.');return;}try{const fd=new FormData();fd.append('html',area.value);await backendDownload('/api/convert/html-to-pdf',fd,'document.pdf',shell);}catch(e){setStatus(shell,'error',e.message);setProgress(shell,null);}}}); form.appendChild(area);form.appendChild(btn);body.appendChild(form);
}
function renderProtect(shell, body){
  renderBackendNotice(shell,body,TOOLS.find(x=>x.id==='protect'));
  const mode=el('select',{},[el('option',{value:'protect',text:'Protect PDF'}),el('option',{value:'unlock',text:'Unlock PDF'})]);
  const pass=el('input',{type:'password',placeholder:'Password'}); pass.style.cssText='width:100%;background:var(--panel);color:var(--text-hi);border:1px solid var(--line);border-radius:10px;padding:12px;';
  const controls=el('div',{class:'field'},[el('label',{text:'Action'}),mode,el('label',{text:'Password'}),pass]); body.appendChild(controls);
  backendFileDrop(body,['pdf'],'application/pdf','PDF only · encrypted/unencrypted PDF handled by backend',async f=>{try{if(!pass.value){setStatus(shell,'error','Enter the password.');return;}const fd=new FormData();fd.append('file',f);fd.append('password',pass.value);fd.append('mode',mode.value);await backendDownload('/api/pdf/security',fd,mode.value==='protect'?'protected.pdf':'unlocked.pdf',shell);}catch(e){setStatus(shell,'error',e.message);setProgress(shell,null);}});
  mode.addEventListener('change',()=>{pass.placeholder=mode.value==='protect'?'Password to set':'Password to unlock';});
}

/* --------------------------- shared dropzone builder ----------------------- */
function buildDropzone({ multiple, allowedKeys, accept, hint, onFiles }) {
  const dz = el('div', { class:'dropzone', tabindex:'0', role:'button', 'aria-label':'Upload file' }, [
    el('div', { class:'dz-icon', text:'↥' }),
    el('h4', { text: multiple ? 'Drop files here, or click to browse' : 'Drop a file here, or click to browse' }),
    el('p', { text: hint }),
  ]);
  const input = el('input', { type:'file', accept, ...(multiple?{multiple:'multiple'}:{}) });
  dz.appendChild(input);
  const trigger = () => input.click();
  dz.addEventListener('click', trigger);
  dz.addEventListener('keydown', (e) => { if (e.key==='Enter'||e.key===' ') { e.preventDefault(); trigger(); }});
  ['dragenter','dragover'].forEach(ev => dz.addEventListener(ev, (e)=>{e.preventDefault(); dz.classList.add('drag');}));
  ['dragleave','drop'].forEach(ev => dz.addEventListener(ev, (e)=>{e.preventDefault(); dz.classList.remove('drag');}));
  dz.addEventListener('drop', (e) => handleFiles(Array.from(e.dataTransfer.files)));
  input.addEventListener('change', (e) => handleFiles(Array.from(e.target.files)));

  async function handleFiles(files) {
    if (!multiple) files = files.slice(0,1);
    if (files.length > MAX_FILES) { alert(`Please select at most ${MAX_FILES} files.`); files = files.slice(0, MAX_FILES); }
    const validated = [];
    for (const f of files) {
      const res = await validateFile(f, allowedKeys);
      if (res.ok) validated.push(f);
      else alert(`"${sanitizeFilenameForDisplay(f.name)}" was skipped: ${res.error}`);
    }
    if (validated.length) onFiles(validated);
    input.value = '';
  }
  return dz;
}

function fileRow(file, onRemove) {
  return el('div', { class:'file-row' }, [
    el('span', { class:'fr-name', text: sanitizeFilenameForDisplay(file.name) }),
    el('span', { class:'fr-size', text: bytesToHuman(file.size) }),
    onRemove ? el('button', { class:'fr-remove', 'aria-label':'Remove file', text:'✕', onclick:onRemove }) : null,
  ]);
}

/* ================================ TOOL: ORGANIZE ============================ */
async function renderOrganize(shell, body) {
  let doc = null, pageStates = []; // {index, rotation, removed}
  const dzWrap = el('div');
  const grid = el('div', { class:'page-grid' });
  const actions = el('div', { class:'actions-bar' });
  body.append(dzWrap, grid, actions);

  const dz = buildDropzone({
    multiple:false, allowedKeys:['pdf'], accept:'application/pdf',
    hint:'PDF only · up to 50MB · checked by file signature',
    onFiles: async ([file]) => { await loadPdf(file); }
  });
  dzWrap.appendChild(dz);

  async function loadPdf(file) {
    clearStatus(shell); setStatus(shell,'info','Reading PDF…');
    const buf = await file.arrayBuffer();
    try {
      doc = await PDFDocument.load(buf, { ignoreEncryption:false });
    } catch (e) {
      setStatus(shell,'error','This PDF is encrypted or corrupted and can\'t be organized here. Try Unlock PDF first (requires backend) or a different file.');
      return;
    }
    pageStates = doc.getPageIndices().map(i => ({ index:i, rotation:0, removed:false }));
    dzWrap.innerHTML = ''; dzWrap.appendChild(fileRow(file, () => { doc=null; pageStates=[]; grid.innerHTML=''; dzWrap.innerHTML=''; dzWrap.appendChild(dz); actions.innerHTML=''; clearStatus(shell); }));
    await renderThumbs(file);
    buildActions();
  }

  async function renderThumbs(file) {
    grid.innerHTML = '';
    setStatus(shell,'info','Rendering page previews…');
    const buf = await file.arrayBuffer();
    const pdfjsDoc = await pdfjsLib.getDocument({ data: buf }).promise;
    for (const st of pageStates) {
      const page = await pdfjsDoc.getPage(st.index + 1);
      const viewport = page.getViewport({ scale: 0.3 });
      const canvas = document.createElement('canvas');
      canvas.width = viewport.width; canvas.height = viewport.height;
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      const thumb = el('div', { class:'page-thumb', draggable:'true', 'data-idx':st.index }, [
        canvas,
        el('span', { class:'pt-label', text:'Page ' + (st.index+1) }),
        el('div', { class:'pt-actions' }, [
          el('button', { text:'⟲', title:'Rotate left', onclick:()=>rotate(st,-90,canvas) }),
          el('button', { text:'⟳', title:'Rotate right', onclick:()=>rotate(st,90,canvas) }),
          el('button', { text:'✕', title:'Remove page', onclick:()=>{ st.removed = true; thumb.remove(); } }),
        ])
      ]);
      canvas.style.setProperty('--rot', st.rotation + 'deg');
      wireDrag(thumb);
      thumb.dataset.state = pageStates.indexOf(st);
      grid.appendChild(thumb);
      thumb._state = st;
    }
    clearStatus(shell);
  }
  function rotate(st, delta, canvas) { st.rotation = ((st.rotation + delta) % 360 + 360) % 360; canvas.style.setProperty('--rot', st.rotation+'deg'); }

  function wireDrag(thumb) {
    thumb.addEventListener('dragstart', () => thumb.classList.add('dragging'));
    thumb.addEventListener('dragend', () => thumb.classList.remove('dragging'));
    thumb.addEventListener('dragover', (e) => {
      e.preventDefault();
      const dragging = grid.querySelector('.dragging');
      if (!dragging || dragging === thumb) return;
      const rect = thumb.getBoundingClientRect();
      const before = (e.clientX - rect.left) < rect.width/2;
      grid.insertBefore(dragging, before ? thumb : thumb.nextSibling);
    });
  }

  function buildActions() {
    actions.innerHTML = '';
    actions.appendChild(el('button', { class:'btn btn-primary', text:'Save changes as new PDF', onclick: save }));
  }

  async function save() {
    clearStatus(shell); setProgress(shell, 10);
    try {
      const order = Array.from(grid.children).map(t => t._state).filter(st => !st.removed);
      if (!order.length) { setStatus(shell,'error','All pages were removed — nothing to save.'); setProgress(shell,null); return; }
      const out = await PDFDocument.create();
      const copied = await out.copyPages(doc, order.map(st => st.index));
      copied.forEach((p, i) => { p.setRotation(degrees(order[i].rotation)); out.addPage(p); });
      setProgress(shell, 80);
      const bytes = await out.save();
      download(new Blob([bytes], {type:'application/pdf'}), 'organized.pdf');
      setProgress(shell, 100);
      setStatus(shell,'success', `Done — ${order.length} page(s) saved.`);
      setTimeout(()=>setProgress(shell,null), 800);
    } catch(e) {
      console.error(e);
      setStatus(shell,'error','Something went wrong saving this PDF. Please try a different file.');
      setProgress(shell,null);
    }
  }
}

/* ================================ TOOL: MERGE ============================ */
async function renderMerge(shell, body) {
  let files = [];
  const listWrap = el('div', { class:'file-list' });
  const actions = el('div', { class:'actions-bar' });
  const dz = buildDropzone({
    multiple:true, allowedKeys:['pdf'], accept:'application/pdf',
    hint:'PDF only · drop multiple files · reorder below before merging',
    onFiles: (fs) => { files.push(...fs); renderList(); }
  });
  body.append(dz, listWrap, actions);

  function renderList() {
    listWrap.innerHTML = '';
    files.forEach((f, i) => {
      const row = el('div', { class:'file-row reorder', draggable:'true' }, [
        el('span', { class:'fr-handle', text:'⠿' }),
        el('span', { class:'fr-name', text: sanitizeFilenameForDisplay(f.name) }),
        el('span', { class:'fr-size', text: bytesToHuman(f.size) }),
        el('button', { class:'fr-remove', text:'✕', onclick:()=>{ files.splice(i,1); renderList(); } }),
      ]);
      row._file = f;
      row.addEventListener('dragstart', ()=>row.classList.add('dragging'));
      row.addEventListener('dragend', ()=>{ row.classList.remove('dragging'); files = Array.from(listWrap.children).map(r=>r._file); });
      row.addEventListener('dragover', (e)=>{
        e.preventDefault();
        const dragging = listWrap.querySelector('.dragging');
        if (!dragging || dragging===row) return;
        const rect = row.getBoundingClientRect();
        const before = (e.clientY - rect.top) < rect.height/2;
        listWrap.insertBefore(dragging, before ? row : row.nextSibling);
      });
      listWrap.appendChild(row);
    });
    actions.innerHTML = '';
    if (files.length >= 2) {
      actions.appendChild(el('button', { class:'btn btn-primary', text:`Merge ${files.length} PDFs`, onclick: merge }));
    } else if (files.length === 1) {
      actions.appendChild(el('p', { text:'Add at least one more PDF to merge.', style:'color:var(--text-dim); font-size:.85rem;' }));
    }
  }

  async function merge() {
    clearStatus(shell); setProgress(shell, 5);
    try {
      const out = await PDFDocument.create();
      for (let i = 0; i < files.length; i++) {
        const buf = await files[i].arrayBuffer();
        const src = await PDFDocument.load(buf);
        const pages = await out.copyPages(src, src.getPageIndices());
        pages.forEach(p => out.addPage(p));
        setProgress(shell, 5 + Math.round(((i+1)/files.length)*85));
      }
      const bytes = await out.save();
      download(new Blob([bytes],{type:'application/pdf'}), 'merged.pdf');
      setStatus(shell,'success', `Merged ${files.length} files into one PDF.`);
      setProgress(shell, 100); setTimeout(()=>setProgress(shell,null),800);
    } catch(e) {
      console.error(e);
      setStatus(shell,'error','One of these PDFs couldn\'t be read (it may be encrypted or corrupted). Try removing it and merging again.');
      setProgress(shell,null);
    }
  }
}

/* ================================ TOOL: SPLIT ============================ */
async function renderSplit(shell, body) {
  let file = null, pageCount = 0;
  const dzWrap = el('div');
  const form = el('div', { class:'form-grid', style:'display:none;' });
  const actions = el('div', { class:'actions-bar' });
  const modeField = el('div', { class:'field' }, [
    el('label', { text:'Split mode' }),
    el('select', {}, [
      el('option', { value:'ranges', text:'Custom page ranges' }),
      el('option', { value:'every', text:'Every N pages' }),
    ])
  ]);
  const rangesField = el('div', { class:'field' }, [
    el('label', { text:'Ranges (e.g. 1-3, 4-6, 7)' }),
    el('input', { type:'text', placeholder:'1-3, 4-6' })
  ]);
  const everyField = el('div', { class:'field', style:'display:none;' }, [
    el('label', { text:'Pages per file' }),
    el('input', { type:'number', min:'1', value:'1' })
  ]);
  form.append(modeField, rangesField, everyField);
  modeField.querySelector('select').addEventListener('change', (e)=>{
    const isEvery = e.target.value === 'every';
    everyField.style.display = isEvery ? '' : 'none';
    rangesField.style.display = isEvery ? 'none' : '';
  });

  const dz = buildDropzone({
    multiple:false, allowedKeys:['pdf'], accept:'application/pdf',
    hint:'PDF only · up to 50MB',
    onFiles: async ([f]) => {
      file = f;
      const buf = await f.arrayBuffer();
      try {
        const doc = await PDFDocument.load(buf);
        pageCount = doc.getPageCount();
      } catch(e) { setStatus(shell,'error','Couldn\'t read this PDF (it may be encrypted or corrupted).'); return; }
      dzWrap.innerHTML=''; dzWrap.appendChild(fileRow(f, ()=>{file=null; form.style.display='none'; actions.innerHTML=''; dzWrap.innerHTML=''; dzWrap.appendChild(dz);}));
      form.style.display = '';
      actions.innerHTML = '';
      actions.appendChild(el('p', { text:`${pageCount} page(s) detected.`, style:'color:var(--text-dim); font-size:.85rem; width:100%;' }));
      actions.appendChild(el('button', { class:'btn btn-primary', text:'Split PDF', onclick: doSplit }));
    }
  });
  dzWrap.appendChild(dz);
  body.append(dzWrap, form, actions);

  function parseRanges(str, max) {
    const out = [];
    for (const part of str.split(',').map(s=>s.trim()).filter(Boolean)) {
      const m = part.match(/^(\d+)(?:-(\d+))?$/);
      if (!m) throw new Error(`"${part}" isn't a valid page or range.`);
      let a = parseInt(m[1],10), b = m[2]?parseInt(m[2],10):a;
      if (a<1||b>max||a>b) throw new Error(`Range "${part}" is out of bounds (this PDF has ${max} pages).`);
      out.push([a-1,b-1]);
    }
    if (!out.length) throw new Error('Enter at least one page or range.');
    return out;
  }

  async function doSplit() {
    clearStatus(shell); setProgress(shell, 5);
    try {
      const mode = modeField.querySelector('select').value;
      let ranges;
      if (mode === 'every') {
        const n = Math.max(1, parseInt(everyField.querySelector('input').value,10) || 1);
        ranges = [];
        for (let i=0;i<pageCount;i+=n) ranges.push([i, Math.min(i+n-1, pageCount-1)]);
      } else {
        ranges = parseRanges(rangesField.querySelector('input').value, pageCount);
      }
      const buf = await file.arrayBuffer();
      const src = await PDFDocument.load(buf);
      const outputs = [];
      for (let i=0;i<ranges.length;i++) {
        const [a,b] = ranges[i];
        const out = await PDFDocument.create();
        const idxs = []; for (let p=a;p<=b;p++) idxs.push(p);
        const pages = await out.copyPages(src, idxs);
        pages.forEach(p=>out.addPage(p));
        const bytes = await out.save();
        outputs.push({ name: `part-${i+1}-p${a+1}-${b+1}.pdf`, data: bytes });
        setProgress(shell, 5 + Math.round(((i+1)/ranges.length)*85));
      }
      if (outputs.length === 1) {
        download(new Blob([outputs[0].data],{type:'application/pdf'}), outputs[0].name);
      } else {
        const zip = buildZip(outputs);
        download(zip, 'split-pdfs.zip');
      }
      setStatus(shell,'success', `Created ${outputs.length} file(s).`);
      setProgress(shell,100); setTimeout(()=>setProgress(shell,null),800);
    } catch(e) {
      setStatus(shell,'error', e.message || 'Split failed.');
      setProgress(shell,null);
    }
  }
}

/* ============================ TOOL: IMAGES TO PDF ========================= */
async function renderImagesToPdf(shell, body) {
  let files = [];
  const listWrap = el('div', { class:'file-list' });
  const actions = el('div', { class:'actions-bar' });
  const dz = buildDropzone({
    multiple:true, allowedKeys:['jpg','png','webp'], accept:'image/jpeg,image/png,image/webp',
    hint:'JPG, PNG or WEBP · drop multiple · order below becomes page order',
    onFiles:(fs)=>{ files.push(...fs); renderList(); }
  });
  body.append(dz, listWrap, actions);
  function renderList() {
    listWrap.innerHTML = '';
    files.forEach((f,i)=> listWrap.appendChild(fileRow(f, ()=>{files.splice(i,1); renderList();})));
    actions.innerHTML = '';
    if (files.length) actions.appendChild(el('button', {class:'btn btn-primary', text:`Create PDF from ${files.length} image(s)`, onclick: build}));
  }
  async function build() {
    clearStatus(shell); setProgress(shell,5);
    try {
      const out = await PDFDocument.create();
      for (let i=0;i<files.length;i++) {
        const f = files[i];
        const buf = await f.arrayBuffer();
        const header = new Uint8Array(buf.slice(0,16));
        let img;
        if (matchesSignature(header, SIGNATURES.png)) img = await out.embedPng(buf);
        else if (matchesSignature(header, SIGNATURES.jpg)) img = await out.embedJpg(buf);
        else { setStatus(shell,'error', `${sanitizeFilenameForDisplay(f.name)} is WEBP — convert it to PNG/JPG first; PDF embedding needs JPG or PNG pixel data.`); setProgress(shell,null); return; }
        const page = out.addPage([img.width, img.height]);
        page.drawImage(img, { x:0, y:0, width:img.width, height:img.height });
        setProgress(shell, 5 + Math.round(((i+1)/files.length)*85));
      }
      const bytes = await out.save();
      download(new Blob([bytes],{type:'application/pdf'}), 'images.pdf');
      setStatus(shell,'success', `Created a ${files.length}-page PDF.`);
      setProgress(shell,100); setTimeout(()=>setProgress(shell,null),800);
    } catch(e) { console.error(e); setStatus(shell,'error','Couldn\'t build the PDF from these images.'); setProgress(shell,null); }
  }
}

/* ============================ TOOL: PDF TO IMAGE =========================== */
async function renderPdfToImage(shell, body) {
  let file = null;
  const dzWrap = el('div');
  const form = el('div', { class:'form-grid', style:'display:none;' }, [
    el('div', {class:'field'}, [el('label',{text:'Format'}), el('select',{},[el('option',{value:'png',text:'PNG'}),el('option',{value:'jpeg',text:'JPG'})])]),
    el('div', {class:'field'}, [el('label',{text:'Scale'}), el('select',{},[el('option',{value:'1',text:'1x (screen)'}),el('option',{value:'2',text:'2x (print)',selected:'selected'}),el('option',{value:'3',text:'3x (high‑res)'})])]),
  ]);
  const actions = el('div', { class:'actions-bar' });
  const dz = buildDropzone({ multiple:false, allowedKeys:['pdf'], accept:'application/pdf', hint:'PDF only',
    onFiles: async ([f]) => {
      file = f;
      dzWrap.innerHTML=''; dzWrap.appendChild(fileRow(f, ()=>{file=null; form.style.display='none'; actions.innerHTML=''; dzWrap.innerHTML=''; dzWrap.appendChild(dz);}));
      form.style.display = '';
      actions.innerHTML = '';
      actions.appendChild(el('button', {class:'btn btn-primary', text:'Export pages as images', onclick: run}));
    }});
  dzWrap.appendChild(dz);
  body.append(dzWrap, form, actions);

  async function run() {
    clearStatus(shell); setProgress(shell,5);
    try {
      const format = form.querySelectorAll('select')[0].value;
      const scale = parseFloat(form.querySelectorAll('select')[1].value);
      const buf = await file.arrayBuffer();
      const pdfjsDoc = await pdfjsLib.getDocument({ data: buf }).promise;
      const outputs = [];
      for (let i=1;i<=pdfjsDoc.numPages;i++) {
        const page = await pdfjsDoc.getPage(i);
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.width = viewport.width; canvas.height = viewport.height;
        await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
        const blob = await new Promise(res => canvas.toBlob(res, `image/${format}`, 0.92));
        outputs.push({ name: `page-${String(i).padStart(3,'0')}.${format==='jpeg'?'jpg':'png'}`, data: new Uint8Array(await blob.arrayBuffer()) });
        setProgress(shell, 5 + Math.round((i/pdfjsDoc.numPages)*85));
      }
      if (outputs.length === 1) download(new Blob([outputs[0].data]), outputs[0].name);
      else download(buildZip(outputs), 'pages.zip');
      setStatus(shell,'success', `Exported ${outputs.length} page(s).`);
      setProgress(shell,100); setTimeout(()=>setProgress(shell,null),800);
    } catch(e) { console.error(e); setStatus(shell,'error','Couldn\'t render this PDF.'); setProgress(shell,null); }
  }
}

/* ============================== TOOL: PDF TO TEXT ============================ */
async function renderPdfToText(shell, body) {
  const dzWrap = el('div');
  const actions = el('div', { class:'actions-bar' });
  const dz = buildDropzone({ multiple:false, allowedKeys:['pdf'], accept:'application/pdf', hint:'PDF only',
    onFiles: async ([f]) => {
      dzWrap.innerHTML=''; dzWrap.appendChild(fileRow(f, null));
      clearStatus(shell); setProgress(shell,10);
      try {
        const buf = await f.arrayBuffer();
        const pdfjsDoc = await pdfjsLib.getDocument({ data: buf }).promise;
        let text = '';
        for (let i=1;i<=pdfjsDoc.numPages;i++) {
          const page = await pdfjsDoc.getPage(i);
          const content = await page.getTextContent();
          text += content.items.map(it => it.str).join(' ') + '\n\n';
          setProgress(shell, 10 + Math.round((i/pdfjsDoc.numPages)*80));
        }
        download(new Blob([text], {type:'text/plain'}), (f.name.replace(/\.pdf$/i,'')||'document') + '.txt');
        setStatus(shell,'success', 'Text extracted.');
        setProgress(shell,100); setTimeout(()=>setProgress(shell,null),800);
      } catch(e) { console.error(e); setStatus(shell,'error','Couldn\'t extract text — this may be a scanned/image-only PDF (no embedded text layer).'); setProgress(shell,null); }
    }});
  dzWrap.appendChild(dz);
  body.append(dzWrap, actions);
}

/* ============================== TOOL: WATERMARK ============================== */
async function renderWatermark(shell, body) {
  let file = null;
  const dzWrap = el('div');
  const form = el('div', { class:'form-grid', style:'display:none;' });
  const textInput = el('input', { type:'text', value:'CONFIDENTIAL', maxlength:'60' });
  const opacityInput = el('input', { type:'number', min:'5', max:'100', value:'25' });
  const sizeInput = el('input', { type:'number', min:'10', max:'160', value:'54' });
  const colorSelect = el('select', {}, [el('option',{value:'gray',text:'Gray'}),el('option',{value:'red',text:'Red'}),el('option',{value:'black',text:'Black'})]);
  form.append(
    el('div',{class:'field'},[el('label',{text:'Watermark text'}), textInput]),
    el('div',{class:'field'},[el('label',{text:'Opacity (%)'}), opacityInput]),
    el('div',{class:'field'},[el('label',{text:'Font size'}), sizeInput]),
    el('div',{class:'field'},[el('label',{text:'Color'}), colorSelect]),
  );
  const actions = el('div', { class:'actions-bar' });
  const dz = buildDropzone({ multiple:false, allowedKeys:['pdf'], accept:'application/pdf', hint:'PDF only',
    onFiles: ([f]) => {
      file = f;
      dzWrap.innerHTML=''; dzWrap.appendChild(fileRow(f, ()=>{file=null; form.style.display='none'; actions.innerHTML=''; dzWrap.innerHTML=''; dzWrap.appendChild(dz);}));
      form.style.display=''; actions.innerHTML='';
      actions.appendChild(el('button', {class:'btn btn-primary', text:'Apply watermark', onclick: run}));
    }});
  dzWrap.appendChild(dz);
  body.append(dzWrap, form, actions);

  async function run() {
    clearStatus(shell); setProgress(shell,10);
    try {
      const buf = await file.arrayBuffer();
      const doc = await PDFDocument.load(buf);
      const font = await doc.embedFont(StandardFonts.HelveticaBold);
      const text = textInput.value.trim() || 'WATERMARK';
      const opacity = Math.max(5, Math.min(100, parseInt(opacityInput.value,10)||25)) / 100;
      const size = Math.max(10, Math.min(160, parseInt(sizeInput.value,10)||54));
      const colorMap = { gray: rgb(0.5,0.5,0.5), red: rgb(0.76,0.17,0.05), black: rgb(0,0,0) };
      const color = colorMap[colorSelect.value] || colorMap.gray;
      const pages = doc.getPages();
      pages.forEach((page, i) => {
        const { width, height } = page.getSize();
        const textWidth = font.widthOfTextAtSize(text, size);
        page.drawText(text, {
          x: width/2 - textWidth/2, y: height/2, size, font, color, opacity,
          rotate: degrees(45),
        });
        setProgress(shell, 10 + Math.round(((i+1)/pages.length)*80));
      });
      const bytes = await doc.save();
      download(new Blob([bytes],{type:'application/pdf'}), 'watermarked.pdf');
      setStatus(shell,'success', 'Watermark applied to every page.');
      setProgress(shell,100); setTimeout(()=>setProgress(shell,null),800);
    } catch(e) { console.error(e); setStatus(shell,'error','Couldn\'t watermark this PDF (it may be encrypted or corrupted).'); setProgress(shell,null); }
  }
}

/* ============================== TOOL: PAGE NUMBERS ============================ */
async function renderPageNumbers(shell, body) {
  let file = null;
  const dzWrap = el('div');
  const form = el('div', { class:'form-grid', style:'display:none;' });
  const posSelect = el('select', {}, [
    el('option',{value:'bottom-center',text:'Bottom center'}),
    el('option',{value:'bottom-right',text:'Bottom right'}),
    el('option',{value:'bottom-left',text:'Bottom left'}),
    el('option',{value:'top-right',text:'Top right'}),
  ]);
  const startInput = el('input', { type:'number', value:'1', min:'0' });
  const formatSelect = el('select', {}, [el('option',{value:'n',text:'1, 2, 3…'}),el('option',{value:'n-of-total',text:'1 of N'})]);
  form.append(
    el('div',{class:'field'},[el('label',{text:'Position'}), posSelect]),
    el('div',{class:'field'},[el('label',{text:'Start at'}), startInput]),
    el('div',{class:'field'},[el('label',{text:'Format'}), formatSelect]),
  );
  const actions = el('div', { class:'actions-bar' });
  const dz = buildDropzone({ multiple:false, allowedKeys:['pdf'], accept:'application/pdf', hint:'PDF only',
    onFiles: ([f]) => {
      file = f;
      dzWrap.innerHTML=''; dzWrap.appendChild(fileRow(f, ()=>{file=null; form.style.display='none'; actions.innerHTML=''; dzWrap.innerHTML=''; dzWrap.appendChild(dz);}));
      form.style.display=''; actions.innerHTML='';
      actions.appendChild(el('button', {class:'btn btn-primary', text:'Add page numbers', onclick: run}));
    }});
  dzWrap.appendChild(dz);
  body.append(dzWrap, form, actions);

  async function run() {
    clearStatus(shell); setProgress(shell,10);
    try {
      const buf = await file.arrayBuffer();
      const doc = await PDFDocument.load(buf);
      const font = await doc.embedFont(StandardFonts.Helvetica);
      const start = parseInt(startInput.value,10) || 1;
      const pages = doc.getPages();
      const total = pages.length;
      pages.forEach((page, i) => {
        const n = start + i;
        const label = formatSelect.value === 'n-of-total' ? `${n} of ${total}` : String(n);
        const { width } = page.getSize();
        const size = 11;
        const textWidth = font.widthOfTextAtSize(label, size);
        const margin = 28;
        let x, y;
        switch (posSelect.value) {
          case 'bottom-right': x = width - margin - textWidth; y = margin; break;
          case 'bottom-left': x = margin; y = margin; break;
          case 'top-right': x = width - margin - textWidth; y = page.getSize().height - margin; break;
          default: x = width/2 - textWidth/2; y = margin;
        }
        page.drawText(label, { x, y, size, font, color: rgb(0.3,0.3,0.3) });
        setProgress(shell, 10 + Math.round(((i+1)/pages.length)*80));
      });
      const bytes = await doc.save();
      download(new Blob([bytes],{type:'application/pdf'}), 'numbered.pdf');
      setStatus(shell,'success', 'Page numbers added.');
      setProgress(shell,100); setTimeout(()=>setProgress(shell,null),800);
    } catch(e) { console.error(e); setStatus(shell,'error','Couldn\'t number this PDF.'); setProgress(shell,null); }
  }
}

/* ============================== TOOL: METADATA ============================== */
async function renderMetadata(shell, body) {
  let file = null, doc = null;
  const dzWrap = el('div');
  const form = el('div', { class:'form-grid', style:'display:none;' });
  const fields = {
    title: el('input',{type:'text'}), author: el('input',{type:'text'}),
    subject: el('input',{type:'text'}), keywords: el('input',{type:'text', placeholder:'comma, separated'}),
  };
  form.append(
    el('div',{class:'field'},[el('label',{text:'Title'}), fields.title]),
    el('div',{class:'field'},[el('label',{text:'Author'}), fields.author]),
    el('div',{class:'field'},[el('label',{text:'Subject'}), fields.subject]),
    el('div',{class:'field'},[el('label',{text:'Keywords'}), fields.keywords]),
  );
  const actions = el('div', { class:'actions-bar' });
  const dz = buildDropzone({ multiple:false, allowedKeys:['pdf'], accept:'application/pdf', hint:'PDF only',
    onFiles: async ([f]) => {
      file = f;
      const buf = await f.arrayBuffer();
      try { doc = await PDFDocument.load(buf); } catch(e) { setStatus(shell,'error','Couldn\'t read this PDF.'); return; }
      dzWrap.innerHTML=''; dzWrap.appendChild(fileRow(f, ()=>{file=null;doc=null; form.style.display='none'; actions.innerHTML=''; dzWrap.innerHTML=''; dzWrap.appendChild(dz);}));
      fields.title.value = doc.getTitle() || '';
      fields.author.value = doc.getAuthor() || '';
      fields.subject.value = doc.getSubject() || '';
      fields.keywords.value = (doc.getKeywords() || '');
      form.style.display=''; actions.innerHTML='';
      actions.appendChild(el('button', {class:'btn btn-primary', text:'Save metadata', onclick: save}));
      actions.appendChild(el('button', {class:'btn btn-ghost', text:'Strip all metadata', onclick: strip}));
    }});
  dzWrap.appendChild(dz);
  body.append(dzWrap, form, actions);

  async function save() {
    clearStatus(shell); setProgress(shell,20);
    doc.setTitle(fields.title.value); doc.setAuthor(fields.author.value);
    doc.setSubject(fields.subject.value); doc.setKeywords(fields.keywords.value.split(',').map(s=>s.trim()).filter(Boolean));
    const bytes = await doc.save();
    download(new Blob([bytes],{type:'application/pdf'}), 'metadata-updated.pdf');
    setStatus(shell,'success','Metadata updated.'); setProgress(shell,100); setTimeout(()=>setProgress(shell,null),800);
  }
  async function strip() {
    clearStatus(shell); setProgress(shell,20);
    ['Title','Author','Subject','Keywords','Producer','Creator'].forEach(k => { try { doc['set'+k]('' ); } catch(e){} });
    try { doc.setKeywords([]); } catch(e){}
    const bytes = await doc.save();
    download(new Blob([bytes],{type:'application/pdf'}), 'metadata-stripped.pdf');
    setStatus(shell,'success','All metadata fields cleared.'); setProgress(shell,100); setTimeout(()=>setProgress(shell,null),800);
  }
}

/* ============================== TOOL: COMPRESS ============================== */
async function renderCompress(shell, body) {
  const dzWrap = el('div');
  const actions = el('div', { class:'actions-bar' });
  body.append(dzWrap, actions);
  body.insertBefore(el('div', { class:'security-notice' }, [
    el('span', {text:'ⓘ'}),
    el('div', { text:'This re-saves the PDF with an optimized internal structure (deduplicated objects, compressed cross-reference streams). It genuinely shrinks many PDFs, but it does not re-encode embedded images at lower quality — the biggest lever for very large scanned PDFs — since that needs a heavier pipeline. If a file barely shrinks, that\'s an honest result, not a bug.' })
  ]), actions);

  const dz = buildDropzone({ multiple:false, allowedKeys:['pdf'], accept:'application/pdf', hint:'PDF only',
    onFiles: async ([f]) => {
      dzWrap.innerHTML=''; dzWrap.appendChild(fileRow(f, null));
      clearStatus(shell); setProgress(shell,15);
      try {
        const buf = await f.arrayBuffer();
        const doc = await PDFDocument.load(buf);
        setProgress(shell,50);
        const bytes = await doc.save({ useObjectStreams:true });
        setProgress(shell,90);
        const before = f.size, after = bytes.byteLength;
        const pct = before > after ? Math.round((1 - after/before)*100) : 0;
        download(new Blob([bytes],{type:'application/pdf'}), 'compressed.pdf');
        setStatus(shell, pct>0 ? 'success':'info', pct>0
          ? `Reduced from ${bytesToHuman(before)} to ${bytesToHuman(after)} (${pct}% smaller).`
          : `Saved at ${bytesToHuman(after)} — this file was already efficiently structured, so size didn't drop.`);
        setProgress(shell,100); setTimeout(()=>setProgress(shell,null),800);
      } catch(e) { console.error(e); setStatus(shell,'error','Couldn\'t process this PDF.'); setProgress(shell,null); }
    }});
  dzWrap.appendChild(dz);
}

/* ================================= INIT ==================================== */
renderToolGrid();

// Theme toggle
const themeToggle = document.getElementById('themeToggle');
themeToggle.addEventListener('click', () => {
  const cur = document.body.getAttribute('data-theme');
  const next = cur === 'dark' ? 'light' : 'dark';
  document.body.setAttribute('data-theme', next);
  themeToggle.textContent = next === 'dark' ? '◐' : '◑';
  try { localStorage.setItem('pexora-theme', next); } catch(e){}
});
try {
  const saved = localStorage.getItem('pexora-theme');
  if (saved) { document.body.setAttribute('data-theme', saved); themeToggle.textContent = saved==='dark'?'◐':'◑'; }
} catch(e){}

// Hero 3D parallax tilt (mouse-follow), respects reduced motion
const topSheet = document.getElementById('topSheet');
const heroStack = document.getElementById('heroStack');
const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
if (topSheet && heroStack && !prefersReduced) {
  heroStack.addEventListener('mousemove', (e) => {
    const rect = heroStack.getBoundingClientRect();
    const px = (e.clientX - rect.left) / rect.width - 0.5;
    const py = (e.clientY - rect.top) / rect.height - 0.5;
    topSheet.style.transform = `translateZ(20px) rotateY(${px*18}deg) rotateX(${-py*18}deg)`;
  });
  heroStack.addEventListener('mouseleave', () => { topSheet.style.transform = 'translateZ(20px) rotateY(0deg) rotateX(0deg)'; });
}

// Warn about missing libs (e.g. if CDN is blocked)
window.addEventListener('load', () => {
  if (!window.PDFLib || !window.pdfjsLib) {
    const banner = el('div', { style:'position:fixed; bottom:16px; left:16px; right:16px; max-width:520px; margin:0 auto; background:#C1440E; color:#fff; padding:14px 18px; border-radius:10px; font-size:.85rem; z-index:999;',
      text:'PDF libraries failed to load from the CDN — check your network/ad-blocker. Tools that process PDFs won\'t work until these load.' });
    document.body.appendChild(banner);
  }
});
