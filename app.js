'use strict';
/* ═══════════════════════════════════════════════════════════════════
   PRENSA V2.4 · app.js — el motor completo
   Procesamiento 100% local. Nada sale del navegador.
   localStorage guarda SOLO configuración, jamás imágenes.

   V2.4 · TECHO EFECTIVO — el resultado NUNCA pesa más que el original:
   · El objetivo real de compresión es min(objetivo del usuario,
     tamaño del archivo original). Sin objetivo → el propio original.
   · Convertir de formato o recodificar ya solo puede COMPRIMIR.
     «SIN LÍMITE» pasa a significar «no superar el tamaño de partida».
   · Aviso explícito si aun así el resultado supera al original
     (solo posible en MODO MANUAL o en fallback con aviso).
   · PNG-8: la búsqueda binaria de colores ya no se detiene en el
     primer valor que cabe — busca la paleta más grande que cumpla.

   V2.3 — compresión PNG REAL:
   · PNG sin pérdida primero; si no cabe el objetivo →
   · PNG-8 (paleta ≤256 colores, tipo pngquant/TinyPNG) con
     cuantización median-cut propia + escritor PNG-8 propio
     (IHDR/PLTE/tRNS/IDAT/IEND, CRC-32, filtros) + deflate nativo
     del navegador, y búsqueda binaria del número de colores.
   · La transparencia se conserva (tRNS) en PNG y WebP;
     JPG aplana sobre el fondo elegido.

   Estructura (spec §17–47):
   17.1 ESTADO · §24 utilidades · §15 mensajes · §18 init
   ETAPA 1 carga (§19–24) · §23 interfaz
   ETAPA 2 conversión real (§26–33)
   ETAPA 3 compresión según la SALIDA (§34–40):
     compressImage → compressPng · compressJpg · compressWebp
     + motor PNG-8 propio
   §42 processImage · ETAPA 4 processBatch (§43)
   ETAPA 5 resultados · descargas · ZIP nativo
   §46 interfaz · comparador · arranque
   ═══════════════════════════════════════════════════════════════════ */

/* ─── 17.1 · ESTADO PRINCIPAL ─────────────────────────────────── */

const appState = {
  queue: [], processing: false, progress: null, lastSummary: '',
  finalCounts: null, ddOn: false,
  settings: {
    targetKB: 0, unit: 'kb', mode: 'auto', quality: 0.8, format: 'auto',
    bgKind: 'white', bgCustom: '#5A7247',
    resize: false, maxW: '', maxH: '', keepRatio: true
  }
};
const MAX_PIXELS = 40e6;
const OK_MIMES = ['image/jpeg', 'image/png', 'image/webp'];

const WEBP_OK = (() => {
  try { return document.createElement('canvas').toDataURL('image/webp').startsWith('data:image/webp'); }
  catch (e) { return false; }
})();

/* ¿El navegador comprime con deflate (zlib)? — necesario para PNG-8 */
const HAS_DEFLATE = typeof CompressionStream !== 'undefined';

/* ─── §24 · UTILIDADES ────────────────────────────────────────── */

const $  = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const nf  = n => n.toFixed(1).replace('.', ',');
const nextFrame = () => new Promise(r => requestAnimationFrame(() => r()));
const clampInt = (v, min, max, def) => { const n = parseInt(v, 10); return isNaN(n) ? def : Math.min(max, Math.max(min, n)); };

function formatFileSize(b){
  if (b >= 1048576) return nf(b / 1048576) + ' MB';
  const kb = b / 1024;
  return (kb >= 100 ? Math.round(kb) : nf(kb)) + ' KB';
}
function formatParts(b){
  if (b >= 1048576) return { v: nf(b / 1048576), u: 'MB' };
  const kb = b / 1024;
  return { v: kb >= 100 ? String(Math.round(kb)) : nf(kb), u: 'KB' };
}
const formatImageFormat = m => m === 'image/webp' ? 'WEBP' : (m === 'image/png' ? 'PNG' : 'JPG');
const extOf = m => m === 'image/webp' ? 'webp' : (m === 'image/png' ? 'png' : 'jpg');
function calculateReduction(originalSize, finalSize){
  return Math.max(0, (1 - finalSize / originalSize) * 100);
}

const I = {
  dl:  '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="square"><path d="M8 2v8.2M8 10.2 4.8 7M8 10.2 11.2 7M2.2 13.8h11.6"/></svg>',
  eye: '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M1.5 8S3.8 3.5 8 3.5 14.5 8 14.5 8 12.2 12.5 8 12.5 1.5 8 1.5 8Z"/><circle cx="8" cy="8" r="2.4"/></svg>',
  x:   '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M3 3l10 10M13 3 3 13"/></svg>',
  warn:'<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="square"><path d="M8 1.5 15 14H1L8 1.5Z"/><path d="M8 6v3.2M8 11.4v.6"/></svg>',
  retry:'<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="square"><path d="M13.5 8a5.5 5.5 0 1 1-1.7-4M13.5 1.5v3h-3"/></svg>',
  ok:  '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="8" cy="8" r="6.5"/><path d="M5.3 8.2 7 10l3.8-4"/></svg>'
};

/* ─── §15 · MENSAJES CENTRALIZADOS ────────────────────────────── */

function pushMessage(areaId, text){
  const area = document.getElementById(areaId);
  while (area.children.length >= 3) area.firstElementChild.remove();
  const m = document.createElement('div');
  m.className = 'msg';
  m.textContent = text;
  area.hidden = false;
  area.append(m);
  setTimeout(() => {
    m.classList.add('out');
    setTimeout(() => { m.remove(); if (!area.children.length) area.hidden = true; }, 260);
  }, 4200);
}
const showMessage = t => pushMessage('messageArea', t);
const showWarning = t => pushMessage('warningArea', t);
const showError   = t => pushMessage('errorArea', t);
const showSuccess = showMessage;

/* ─── PREFERENCIAS (solo configuración; nunca imágenes) ───────── */

function persistCfg(){ try { localStorage.setItem('prensaV2:cfg', JSON.stringify(appState.settings)); } catch(_){} }
function loadCfg(){
  try {
    const p = JSON.parse(localStorage.getItem('prensaV2:cfg') || '{}');
    Object.keys(p).forEach(k => { if (k in appState.settings) appState.settings[k] = p[k]; });
  } catch(_){}
}

/* ═════ ETAPA 1 · CARGA, VALIDACIÓN, LECTURA (§19–24) ═════ */

function validateFile(file){
  if (file.type && OK_MIMES.includes(file.type)) return { ok: true, claimed: file.type };
  if (/\.(jpe?g)$/i.test(file.name)) return { ok: true, claimed: 'image/jpeg' };
  if (/\.png$/i.test(file.name))     return { ok: true, claimed: 'image/png' };
  if (/\.webp$/i.test(file.name))    return { ok: true, claimed: 'image/webp' };
  return { ok: false, claimed: null };
}

/* Firma binaria: JPG → FF D8 FF · PNG → 89 50 4E 47 0D 0A 1A 0A · WebP → RIFF····WEBP */
async function readSignature(blob){
  const head = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
  if (head[0] === 0xFF && head[1] === 0xD8 && head[2] === 0xFF) return 'image/jpeg';
  if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4E && head[3] === 0x47 &&
      head[4] === 0x0D && head[5] === 0x0A && head[6] === 0x1A && head[7] === 0x0A) return 'image/png';
  if (head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46 &&
      head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50) return 'image/webp';
  return null;
}

async function loadImage(file){
  if (window.createImageBitmap){
    try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch(_){}
    try { return await createImageBitmap(file); } catch(_){}
  }
  const url = URL.createObjectURL(file);
  try {
    return await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error('decode'));
      i.src = url;
    });
  } finally { setTimeout(() => URL.revokeObjectURL(url), 3000); }
}
const srcW = s => s.naturalWidth || s.width;
const srcH = s => s.naturalHeight || s.height;

const createPreviewUrl = file => URL.createObjectURL(file);
const revokePreviewUrl = url => { try { URL.revokeObjectURL(url); } catch(_){} }

async function getImageMetadata(file){
  const sig = await readSignature(file);
  if (!sig) return { rejected: true };
  const claimed = validateFile(file).claimed;
  try {
    const src = await loadImage(file);
    const w = srcW(src), h = srcH(src);
    if (!w || !h) throw new Error('decode');
    if (w * h > MAX_PIXELS){
      if (src.close) src.close();
      return { error: 'La imagen es demasiado grande (' + w + '×' + h + ') para procesarla de forma segura en este dispositivo.', format: sig };
    }
    const alpha = sig !== 'image/jpeg' ? detectTransparency(src) : false;
    if (src.close) src.close();
    return { format: sig, claimed, width: w, height: h, alpha };
  } catch(_){
    return { error: 'No fue posible leer esta imagen (archivo dañado o incompatible).', format: sig, claimed };
  }
}

function handleFileSelection(event){
  handleFiles(event.target.files);
  event.target.value = '';
}
function handleDrop(event){
  event.preventDefault();
  handleFiles(event.dataTransfer.files);
}

async function handleFiles(files){
  let added = 0;
  for (const file of [...files]){
    const meta = await getImageMetadata(file);
    if (meta.rejected){
      showError('«' + file.name + '» no contiene una imagen JPG, PNG o WebP válida.');
      continue;
    }
    const item = {
      id: uid(), file, sw: 0, sh: 0, alpha: false, format: meta.format || '',
      status: 'wait', result: null, warns: [], blocker: null, errorMsg: null, logHTML: []
    };
    item.previewUrl = createPreviewUrl(file);
    if (meta.error){
      item.status = 'error';
      item.errorMsg = meta.error;
    } else {
      item.format = meta.format;
      item.sw = meta.width; item.sh = meta.height;
      item.alpha = meta.alpha;
      if (meta.claimed && meta.claimed !== meta.format)
        showWarning('«' + file.name + '» figura como ' + formatImageFormat(meta.claimed) + ', pero su contenido real es ' + formatImageFormat(meta.format) + ' — se procesará como ' + formatImageFormat(meta.format) + '.');
      else if (!meta.claimed)
        showWarning('«' + file.name + '» tiene extensión no reconocida; su contenido es ' + formatImageFormat(meta.format) + '.');
    }
    appState.queue.push(item);
    if (appState.processing) $('#imageList').append(renderImageCard(item, true));
    added++;
  }
  if (added){
    if (!appState.processing) renderImageList(); else updateQueueInfo();
    updateImageCounter();
    updateJpgBackgroundUI();
    const bad = appState.queue.filter(i => i.status === 'error').length;
    if (bad) showWarning(bad + (bad === 1 ? ' imagen con error en la cola' : ' imágenes con error en la cola'));
    else showSuccess(added + (added === 1 ? ' imagen añadida' : ' imágenes añadidas'));
  }
}

/* ─── §23 · INTERFAZ DE IMÁGENES ──────────────────────────────── */

function buildCardHTML(item){
  const tipo = formatImageFormat(item.format || 'image/jpeg');
  const alphaTag = item.alpha ? '<span class="tag">TRANSPARENTE</span>' : '';
  const base =
    '<div class="image-preview" data-act="compare"><img src="' + item.previewUrl + '" alt=""></div>' +
    '<div class="image-info">' +
      '<div class="image-name">' + esc(item.file.name) + alphaTag + '</div>' +
      '<div class="image-meta">' + tipo + (item.sw ? ' · ' + item.sw + '×' + item.sh + ' · ' : ' · ') + formatFileSize(item.file.size) + '</div>';

  if (item.status === 'wait'){
    return base + '</div>' +
      '<div class="image-side">' +
        '<div class="image-status"><span class="status status-pending">EN ESPERA</span></div>' +
        '<div class="image-actions"><button class="ibtn danger" data-act="remove" aria-label="Quitar de la cola" type="button">' + I.x + '</button></div>' +
      '</div>';
  }

  if (item.status === 'working'){
    return base + '<div class="process-log"></div></div>' +
      '<div class="image-side">' +
        '<div class="image-status"><span class="status status-preparing">PREPARANDO</span></div>' +
        '<div class="image-actions"></div>' +
      '</div>';
  }

  if (item.status === 'error'){
    return base +
      (item.logHTML.length ? '<details class="process-details"><summary>PROCESO · ' + item.logHTML.length + ' PASADAS</summary><div class="process-log">' + item.logHTML.join('') + '</div></details>' : '') +
      '<div class="errbox">' + I.warn + '<span>' + esc(item.errorMsg || 'Error durante el procesamiento.') + '</span>' +
        '<button class="ibtn" data-act="retry" aria-label="Reintentar" title="Reintentar" type="button">' + I.retry + '</button></div>' +
      '</div>' +
      '<div class="image-side">' +
        '<div class="image-status"><span class="status status-error">ERROR</span></div>' +
        '<div class="image-actions"><button class="ibtn danger" data-act="remove" aria-label="Quitar" type="button">' + I.x + '</button></div>' +
      '</div>';
  }

  /* §44 · resultado integrado en la misma tarjeta */
  const r = item.result, p = formatParts(r.outputSize);
  const pct = r.passthrough ? null : calculateReduction(item.file.size, r.outputSize);
  const statusHTML = item.blocker
    ? '<span class="status status-warning">CON AVISO</span>'
    : (r.passthrough ? '<span class="status status-completed">YA CUMPLE</span>' : '<span class="status status-completed">COMPLETADA</span>');
  const sizeHTML =
    '<div class="image-size stamp"><span>' + p.v + '</span><span class="u">' + p.u + '</span></div>' +
    (pct !== null ? '<div class="reduction-badge">−' + nf(pct) + '%</div>'
                  : (r.passthrough ? '<div class="reduction-badge">SIN PÉRDIDA</div>' : ''));
  const qualityTxt = r.pngColors
    ? ' · PNG-8 · ' + r.pngColors + ' COLORES'
    : (r.passthrough ? ' · ORIGINAL SIN PÉRDIDA' : (r.quality !== null ? ' · CALIDAD ' + r.quality.toFixed(2) : ' · SIN PÉRDIDA'));

  const fixes = item.blocker
    ? '<div class="warnbox">' + I.warn + '<div><p>' + esc(item.blocker) + '</p>' +
        '<div class="fixacts">' +
          '<button class="fbtn" data-act="fix-resize" type="button">REDUCIR A 1600 PX</button>' +
          (r.outputFormat !== 'image/webp' && WEBP_OK ? '<button class="fbtn" data-act="fix-webp" type="button">CAMBIAR A WEBP</button>' : '') +
          '<button class="fbtn" data-act="fix-keep" type="button">MANTENER RESULTADO</button>' +
        '</div></div></div>'
    : '';
  const warns = (item.warns || []).map(w => '<div class="warnbox">' + I.warn + '<span>' + esc(w) + '</span></div>').join('');
  const passInfo = (r.passthrough && !item.blocker)
    ? '<div class="infobox">' + I.ok + '<span>El archivo original ya está en el formato de salida elegido y cumple el objetivo: se entrega tal cual, sin recomprimir.</span></div>'
    : '';

  return base +
    (item.logHTML.length ? '<details class="process-details"><summary>PROCESO · ' + item.logHTML.length + ' PASADAS</summary><div class="process-log">' + item.logHTML.join('') + '</div></details>' : '') +
    '<div class="result-card">' +
      '<div class="result-head"><span>RESULTADO</span><span><b>' + formatImageFormat(r.outputFormat) + '</b>' + qualityTxt + '</span></div>' +
      '<div class="comparison">' +
        '<div><div class="compare-thumb" data-act="compare"><img src="' + item.previewUrl + '" alt="Original"></div>' +
          '<div class="compare-label">ORIGINAL</div><div class="compare-dims">' + formatImageFormat(r.originalFormat) + ' · ' + r.originalWidth + '×' + r.originalHeight + '</div>' +
          '<div class="compare-size">' + formatFileSize(r.originalSize) + '</div></div>' +
        '<div><div class="compare-thumb" data-act="compare"><img src="' + item.resultUrl + '" alt="Resultado"></div>' +
          '<div class="compare-label">RESULTADO</div><div class="compare-dims">' + formatImageFormat(r.outputFormat) + ' · ' + r.outputWidth + '×' + r.outputHeight + '</div>' +
          '<div class="compare-size">' + formatFileSize(r.outputSize) + '</div></div>' +
      '</div>' +
      '<div class="bars">' +
        '<div class="bar-row"><span class="bar-l">ANTES</span><div class="bar-track"><div class="bar-fill" style="width:100%"></div></div><span class="bar-v">' + formatFileSize(r.originalSize) + '</span></div>' +
        '<div class="bar-row"><span class="bar-l">DESPUÉS</span><div class="bar-track"><div class="bar-fill resf"></div></div><span class="bar-v">' + formatFileSize(r.outputSize) + '</span></div>' +
      '</div>' +
      '<div class="result-name">' + esc(r.originalName) + ' → <b>' + esc(r.outputName) + '</b></div>' +
      fixes + warns + passInfo +
      '<div class="result-actions">' +
        (r.passthrough ? '' : '<button class="action-button" data-act="compare" type="button">' + I.eye + 'COMPARAR</button>') +
        '<button class="action-button acc" data-act="download" type="button">' + I.dl + 'DESCARGAR</button>' +
      '</div>' +
    '</div></div>' +
    '<div class="image-side">' + statusHTML + sizeHTML +
      '<div class="image-actions"><button class="ibtn danger" data-act="remove" aria-label="Quitar" type="button">' + I.x + '</button></div>' +
    '</div>';
}

function renderImageCard(item, appendOnly){
  const el = document.createElement('article');
  el.className = 'image-card' + (item.status === 'done' ? ' done' : '');
  el.dataset.id = item.id;
  el.innerHTML = buildCardHTML(item);
  if (appendOnly || !item.el || !item.el.isConnected) $('#imageList').append(el);
  else item.el.replaceWith(el);
  item.el = el;
  item.refs = {
    log: el.querySelector('.process-log'),
    status: el.querySelector('.image-status')
  };
  if (item.status === 'done'){
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const f = el.querySelector('.bar-fill.resf');
      if (f){
        const r = item.result;
        f.style.width = (r.passthrough ? 100 : Math.max(2, Math.min(100, r.outputSize / r.originalSize * 100))) + '%';
      }
    }));
  }
  return el;
}

function renderImageList(){
  $('#resultsSection').hidden = appState.queue.length === 0;
  const list = $('#imageList');
  list.innerHTML = '';
  appState.queue.forEach(it => renderImageCard(it, true));
  if (!appState.queue.length)
    list.innerHTML = '<p class="queue-empty">Las imágenes que cargues aparecerán aquí, con su resultado tras procesarlas.</p>';
  updateQueueInfo();
}

function updateImageCounter(){
  $('#imageCounter').textContent = appState.queue.length;
}

function updateQueueInfo(){
  const q = appState.queue;
  const pend = q.filter(i => i.status === 'wait').length;
  const done = q.filter(i => i.status === 'done').length;
  const warn = q.filter(i => i.status === 'done' && (i.blocker || (i.warns && i.warns.length))).length;
  const err  = q.filter(i => i.status === 'error').length;
  $('#queueInfo').textContent = q.length
    ? pend + ' PENDIENTE' + (pend === 1 ? '' : 'S') +
      (done ? ' · ' + done + ' COMPLETADA' + (done === 1 ? '' : 'S') : '') +
      (warn ? ' · ' + warn + ' CON AVISO' : '') +
      (err  ? ' · ' + err + ' CON ERROR' : '')
    : '';
  $('#clearAllButton').disabled = appState.processing;
  updateProgress();
}

function removeImage(item){
  if (item.status === 'working') return;
  revokePreviewUrl(item.previewUrl);
  if (item.resultUrl) URL.revokeObjectURL(item.resultUrl);
  appState.queue.splice(appState.queue.indexOf(item), 1);
  if (item.el) item.el.remove();
  if (!appState.queue.length) renderImageList(); else updateQueueInfo();
  updateImageCounter();
  updateJpgBackgroundUI();
}

let clearArmed = false, clearTimer = 0;
function clearAllImages(){
  if (appState.processing) return;
  const hasResults = appState.queue.some(i => i.status === 'done');
  const btn = $('#clearAllButton');
  if (hasResults && !clearArmed){
    clearArmed = true;
    btn.textContent = '¿CONFIRMAR? PULSA OTRA VEZ';
    btn.classList.add('armed');
    clearTimeout(clearTimer);
    clearTimer = setTimeout(() => { clearArmed = false; btn.textContent = 'LIMPIAR TODO'; btn.classList.remove('armed'); }, 5000);
    return;
  }
  clearTimeout(clearTimer); clearArmed = false;
  btn.textContent = 'LIMPIAR TODO'; btn.classList.remove('armed');
  appState.queue.forEach(it => {
    revokePreviewUrl(it.previewUrl);
    if (it.resultUrl) URL.revokeObjectURL(it.resultUrl);
  });
  appState.queue = [];
  appState.lastSummary = '';
  renderImageList();
  updateImageCounter();
  showSuccess('Interfaz limpia — los archivos originales de tu equipo nunca se tocan');
}

/* ═════ ETAPA 2 · CANVAS, CONVERSIÓN REAL, TRANSPARENCIA (§26–33) ═════ */

function createCanvas(w, h){
  const c = document.createElement('canvas');
  c.width = Math.max(1, w); c.height = Math.max(1, h);
  const x = c.getContext('2d');
  x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
  return c;
}

function calculateOutputDimensions(item, cfg, forceMax){
  let w = item.sw, h = item.sh;
  const on = cfg.resize || !!forceMax;
  if (on){
    const mw = forceMax ? forceMax.w : (cfg.maxW || Infinity);
    const mh = forceMax ? forceMax.h : (cfg.maxH || Infinity);
    if (cfg.keepRatio){ const s = Math.min(1, mw / w, mh / h); w = Math.round(w * s); h = Math.round(h * s); }
    else { w = Math.min(w, mw); h = Math.min(h, mh); }
  }
  return { w: Math.max(1, w), h: Math.max(1, h), resized: w !== item.sw || h !== item.sh };
}

function drawImageToCanvas(src, tw, th, bg){
  let cw = srcW(src), ch = srcH(src), cur = src;
  if (tw < cw * 0.5){
    const steps = Math.floor(Math.log2(cw / tw));
    for (let i = 0; i < steps; i++){
      const nw = Math.max(tw, Math.round(cw / 2)), nh = Math.max(th, Math.round(ch / 2));
      if (nw >= cw || nh >= ch) break;
      const c = createCanvas(nw, nh);
      c.getContext('2d').drawImage(cur, 0, 0, nw, nh);
      cur = c; cw = nw; ch = nh;
    }
  }
  const out = createCanvas(tw, th);
  const ox = out.getContext('2d');
  if (bg){ ox.fillStyle = bg; ox.fillRect(0, 0, out.width, out.height); }
  ox.drawImage(cur, 0, 0, out.width, out.height);
  return out;
}

/* §28 · getOutputFormat — la elección del usuario manda SIEMPRE */
function getOutputFormat(item, cfg, resized, target){
  if (cfg.format !== 'auto') return cfg.format;
  const inMime = item.format || 'image/jpeg';
  if (cfg.mode === 'manual') return inMime;
  if (target === null) return inMime;
  if (!resized && item.file.size <= target) return inMime;
  if (item.alpha) return WEBP_OK ? 'image/webp' : 'image/png';
  return WEBP_OK ? 'image/webp' : 'image/jpeg';
}

function detectTransparency(src){
  const s = Math.min(1, 192 / Math.max(srcW(src), srcH(src)));
  const c = createCanvas(Math.max(1, Math.round(srcW(src) * s)), Math.max(1, Math.round(srcH(src) * s)));
  const x = c.getContext('2d');
  x.drawImage(src, 0, 0, c.width, c.height);
  const d = x.getImageData(0, 0, c.width, c.height).data;
  for (let i = 3; i < d.length; i += 4) if (d[i] < 255) return true;
  return false;
}
function getBackgroundColor(cfg){
  return cfg.bgKind === 'white' ? '#FFFFFF' : (cfg.bgKind === 'black' ? '#14110B' : cfg.bgCustom);
}

async function verifyOutputBlob(blob, expectedMime){
  if (!blob) return { ok: false, reason: 'El navegador no pudo codificar ' + formatImageFormat(expectedMime) + '.' };
  if (blob.type && blob.type !== expectedMime && blob.type !== 'image/jpg')
    return { ok: false, reason: 'La codificación ' + formatImageFormat(expectedMime) + ' no está soportada en este navegador.' };
  const sig = await readSignature(blob);
  if (sig !== expectedMime)
    return { ok: false, reason: 'El archivo generado no contiene ' + formatImageFormat(expectedMime) + ' real (firma binaria incorrecta).' };
  return { ok: true };
}

async function encodeImage(src, w, h, mime, q, bg){
  const c = drawImageToCanvas(src, w, h, bg);
  const blob = await new Promise(res => c.toBlob(res, mime, q));
  c.width = 0; c.height = 0;
  const check = await verifyOutputBlob(blob, mime);
  if (!check.ok) throw new Error(check.reason);
  return blob;
}

/* ═════ ETAPA 3 · COMPRESIÓN SEGÚN EL FORMATO DE SALIDA (§34–40) ═════ */

async function compressImage(src, dims, outMime, opts, ui){
  if (outMime === 'image/png')  return compressPng(src, dims, opts, ui);
  if (outMime === 'image/jpeg') return compressJpg(src, dims, opts, ui);
  return compressWebp(src, dims, opts, ui);
}

/* ─── MOTOR PNG-8 PROPIO (sin librerías) ─────────────────────────
   1) deflate del navegador (zlib, exactamente lo que pide PNG)
   2) escritor de chunks PNG con CRC-32 (reutiliza el del ZIP)
   3) cuantización median-cut con paletas jerárquicas por nivel
      (la búsqueda binaria de colores no re-cuantiza píxeles:
       re-mapea índices de la paleta de 256)                    */

async function deflateBytes(bytes){
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function pngChunk(type, data){
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length, false);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)), false);
  return out;
}

async function encodePng8(width, height, palette, indices){
  const n = palette.length;
  const stride = width;
  const raw = new Uint8Array((stride + 1) * height);

  /* filtros de scanline 0/1/2 adaptativos (mejora el deflate) */
  for (let y = 0; y < height; y++){
    const inOff = y * stride;
    const outOff = y * (stride + 1);
    const upOff = (y - 1) * stride;
    let s0 = 0, s1 = 0, s2 = 0;
    for (let x = 0; x < stride; x++){
      const v = indices[inOff + x];
      const left = x > 0 ? indices[inOff + x - 1] : 0;
      const up = y > 0 ? indices[upOff + x] : 0;
      s0 += v; s1 += Math.abs(v - left); s2 += Math.abs(v - up);
    }
    let f = 0;
    if (s1 <= s0 && s1 <= s2) f = 1;
    else if (s2 < s0 && s2 < s1) f = 2;
    raw[outOff] = f;
    for (let x = 0; x < stride; x++){
      const v = indices[inOff + x];
      const left = x > 0 ? indices[inOff + x - 1] : 0;
      const up = y > 0 ? indices[upOff + x] : 0;
      raw[outOff + 1 + x] = f === 0 ? v : (f === 1 ? (v - left) & 0xFF : (v - up) & 0xFF);
    }
  }

  const idat = await deflateBytes(raw);

  const ihdr = new Uint8Array(13);
  const hdv = new DataView(ihdr.buffer);
  hdv.setUint32(0, width, false);
  hdv.setUint32(4, height, false);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 3;   // color type: paleta

  const plte = new Uint8Array(n * 3);
  const trns = new Uint8Array(n);
  let hasAlpha = false;
  for (let i = 0; i < n; i++){
    const P = palette[i];
    plte[i * 3] = P[0]; plte[i * 3 + 1] = P[1]; plte[i * 3 + 2] = P[2];
    trns[i] = P[3];
    if (P[3] < 255) hasAlpha = true;
  }

  const parts = [
    new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    pngChunk('IHDR', ihdr),
    pngChunk('PLTE', plte)
  ];
  if (hasAlpha) parts.push(pngChunk('tRNS', trns));
  parts.push(pngChunk('IDAT', idat));
  parts.push(pngChunk('IEND', new Uint8Array(0)));

  let total = 0;
  parts.forEach(p => total += p.length);
  const all = new Uint8Array(total);
  let o = 0;
  parts.forEach(p => { all.set(p, o); o += p.length; });
  return new Blob([all], { type: 'image/png' });
}

/* prueba de oro: el PNG-8 debe decodificar en el navegador */
async function assertDecodable(blob){
  if (typeof createImageBitmap === 'undefined') return true;
  try { const b = await createImageBitmap(blob); b.close(); return true; }
  catch(_){ return false; }
}

/* ─── cuantización median-cut ─────────────────────────────────── */

function collectColorSamples(imageData){
  const d = imageData.data;
  const total = d.length / 4;
  const step = Math.max(1, Math.floor(total / 200000)); // ≤200k muestras
  const map = new Map();
  for (let i = 0; i < d.length; i += 4 * step){
    const k = d[i] * 0x1000000 + d[i + 1] * 0x10000 + d[i + 2] * 0x100 + d[i + 3];
    const e = map.get(k);
    if (e) e[4] += step;
    else map.set(k, [d[i], d[i + 1], d[i + 2], d[i + 3], step]);
  }
  return [...map.values()];
}

function boxSpread(box){
  const mn = [255, 255, 255, 255], mx = [0, 0, 0, 0];
  for (const c of box){
    for (let ch = 0; ch < 4; ch++){
      if (c[ch] < mn[ch]) mn[ch] = c[ch];
      if (c[ch] > mx[ch]) mx[ch] = c[ch];
    }
  }
  return Math.max(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2], mx[3] - mn[3]);
}

function splitBox(box){
  const mn = [255, 255, 255, 255], mx = [0, 0, 0, 0];
  for (const c of box){
    for (let ch = 0; ch < 4; ch++){
      if (c[ch] < mn[ch]) mn[ch] = c[ch];
      if (c[ch] > mx[ch]) mx[ch] = c[ch];
    }
  }
  let ch = 0, rng = mx[0] - mn[0];
  for (let c = 1; c < 4; c++){ if (mx[c] - mn[c] > rng){ rng = mx[c] - mn[c]; ch = c; } }
  const sorted = [...box].sort((a, b) => a[ch] - b[ch]);
  const mid = Math.floor(sorted.length / 2);
  return [sorted.slice(0, mid), sorted.slice(mid)];
}

function paletteOfBoxes(boxes){
  return boxes.map(box => {
    let r = 0, g = 0, b = 0, a = 0, w = 0;
    for (const c of box){ r += c[0] * c[4]; g += c[1] * c[4]; b += c[2] * c[4]; a += c[3] * c[4]; w += c[4]; }
    return w ? [Math.round(r / w), Math.round(g / w), Math.round(b / w), Math.round(a / w)] : [0, 0, 0, 255];
  });
}

/* paletas jerárquicas: levels[k] = paleta de k+1 colores.
   Permite probar N colores sin re-cuantizar los píxeles. */
function buildPaletteLevels(samples, maxColors){
  let boxes = [samples];
  const levels = [paletteOfBoxes(boxes)];
  while (boxes.length < maxColors){
    let bi = -1, bestScore = 0;
    boxes.forEach((box, i) => {
      if (box.length < 2) return;
      const score = boxSpread(box) * box.length;
      if (score > bestScore){ bestScore = score; bi = i; }
    });
    if (bi < 0) break; // todos los colores son únicos: paleta exacta
    const [a, b] = splitBox(boxes[bi]);
    boxes.splice(bi, 1, a, b);
    levels.push(paletteOfBoxes(boxes));
  }
  return levels;
}

function assignPaletteIndices(imageData, palette){
  const d = imageData.data;
  const n = palette.length;
  const idx = new Uint8Array(d.length / 4);
  const cache = new Map(); // clave de rejilla r5g5b5a4 → índice
  for (let p = 0, i = 0; p < d.length; p += 4, i++){
    const r = d[p], g = d[p + 1], b = d[p + 2], a = d[p + 3];
    const key = ((r >> 3) << 14) | ((g >> 3) << 9) | ((b >> 3) << 4) | (a >> 4);
    let j = cache.get(key);
    if (j === undefined){
      let bd = Infinity, bj = 0;
      for (let c = 0; c < n; c++){
        const P = palette[c];
        const dr = r - P[0], dg = g - P[1], db = b - P[2], da = a - P[3];
        const dist = 2 * dr * dr + 4 * dg * dg + 3 * db * db + 10 * da * da;
        if (dist < bd){ bd = dist; bj = c; if (bd === 0) break; }
      }
      j = bj;
      cache.set(key, j);
    }
    idx[i] = j;
  }
  return idx;
}

function nearestInPalette(color, palette){
  let bd = Infinity, bj = 0;
  for (let c = 0; c < palette.length; c++){
    const P = palette[c];
    const dr = color[0] - P[0], dg = color[1] - P[1], db = color[2] - P[2], da = color[3] - P[3];
    const dist = dr * dr + dg * dg + db * db + da * da;
    if (dist < bd){ bd = dist; bj = c; }
  }
  return bj;
}

/* §40 · compressPng — compresión PNG REAL:
   1) sin pérdida; 2) PNG-8 con búsqueda binaria de colores;
   3) si ni con 16 colores cabe → aviso (no se destruye). */
async function compressPng(src, dims, opts, ui){
  ui.setStatus(opts.converting ? 'CONVIRTIENDO A PNG' : 'COMPRIMIENDO PNG',
                opts.converting ? 'converting' : 'compressing');
  if (opts.mode === 'manual')
    ui.log('<span class="log-warn">MODO MANUAL: PNG SE ENTREGA SIN PÉRDIDA (LA CALIDAD NO APLICA A PNG)</span>');

  /* 1 · PNG sin pérdida a las dimensiones pedidas */
  const lossless = await encodeImage(src, dims.w, dims.h, 'image/png', undefined, null);
  const showTarget = opts.target && opts.mode === 'auto';
  ui.log('<span class="log-step">PNG</span>SIN PÉRDIDA ' + dims.w + '×' + dims.h + ' → <b>' + formatFileSize(lossless.size) + '</b>' +
    (showTarget ? (lossless.size <= opts.target ? ' <span class="log-ok">DENTRO</span>' : ' <span>EXCEDE</span>') : ''));
  if (!showTarget || lossless.size <= opts.target)
    return { blob: lossless, quality: null, pngColors: null, blocker: null };

  /* 2 · PNG-8 con cuantización a paleta */
  if (!HAS_DEFLATE)
    return { blob: lossless, quality: null, pngColors: null,
      blocker: 'Este navegador no puede generar PNG de paleta (sin deflate). El PNG sin pérdida excede el objetivo: reduce las dimensiones o cambia la salida a WebP/JPG.' };

  ui.setStatus('CUANTIZANDO PALETA', 'compressing');
  const canvas = drawImageToCanvas(src, dims.w, dims.h, null); // alpha intacto
  const imgData = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
  canvas.width = 0; canvas.height = 0;

  const samples = collectColorSamples(imgData);
  const levels = buildPaletteLevels(samples, 256);
  const maxN = levels.length;              // <256 si hay menos colores únicos
  const paletteFull = levels[maxN - 1];
  const idxFull = assignPaletteIndices(imgData, paletteFull);
  const minN = Math.min(16, maxN);

  let pass = 0;
  const attempt = async N => {
    pass++;
    let blob;
    if (N === maxN){
      blob = await encodePng8(dims.w, dims.h, paletteFull, idxFull);
    } else {
      const palette = levels[N - 1];
      const remap = new Uint8Array(maxN);
      for (let h = 0; h < maxN; h++) remap[h] = nearestInPalette(paletteFull[h], palette);
      blob = await encodePng8(dims.w, dims.h, palette, idxFull.map(v => remap[v]));
    }
    ui.log('<span class="log-step">P' + String(pass).padStart(2, '0') + '</span>PNG-8 · ' + N + ' COLORES → <b>' + formatFileSize(blob.size) + '</b> ' +
      (blob.size <= opts.target ? '<span class="log-ok">DENTRO</span>' : '<span>EXCEDE</span>'));
    return blob;
  };

  let best = null, fallback = lossless;

  let blob = await attempt(maxN);
  if (blob.size <= opts.target) best = { blob, colors: maxN };
  else {
    fallback = blob;
    let lo = minN, hi = maxN - 1;
    /* V2.4 · sin "&& !best": la búsqueda continúa tras el primer acierto
       para quedarse con la paleta MÁS GRANDE que cumple el techo
       (más colores = más calidad al mismo coste en bytes). */
    while (hi - lo > 8){
      const mid = Math.round((lo + hi) / 2);
      blob = await attempt(mid);
      if (blob.size <= opts.target){ best = { blob, colors: mid }; lo = mid; } // cabe → más colores = más calidad
      else { fallback = blob; hi = mid - 1; }
    }
    if (!best && minN !== maxN){
      blob = await attempt(minN);
      if (blob.size <= opts.target) best = { blob, colors: minN };
      else fallback = blob;
    }
  }

  /* verificación de oro antes de entregar */
  if (best && !(await assertDecodable(best.blob)))
    return { blob: lossless, quality: null, pngColors: null,
      blocker: 'El PNG de paleta generado no superó la verificación de decodificación. Se entrega el PNG sin pérdida (excede el objetivo): reduce dimensiones o usa WebP/JPG.' };

  if (best) return { blob: best.blob, quality: null, pngColors: best.colors, blocker: null };

  return { blob: (fallback.size < lossless.size ? fallback : lossless), quality: null, pngColors: null,
    blocker: 'No fue posible alcanzar ' + formatFileSize(opts.target) + ' ni con paleta de ' + minN + ' colores. Reduce las dimensiones, sube el objetivo o cambia la salida a WebP/JPG.' };
}

async function compressJpg(src, dims, opts, ui){
  const label = opts.converting ? 'CONVIRTIENDO A JPG' : 'COMPRIMIENDO JPG';
  const phase = opts.converting ? 'converting' : 'compressing';

  if (opts.mode === 'manual'){
    ui.setStatus(label, phase);
    const blob = await encodeImage(src, dims.w, dims.h, 'image/jpeg', opts.quality, opts.bg);
    ui.log('<span class="log-step">JPG</span>CALIDAD MANUAL ' + opts.quality.toFixed(2) + ' → <b>' + formatFileSize(blob.size) + '</b>');
    return { blob, quality: opts.quality, blocker: null };
  }
  if (opts.target === null){
    ui.setStatus(label, phase);
    const blob = await encodeImage(src, dims.w, dims.h, 'image/jpeg', 0.92, opts.bg);
    ui.log('<span class="log-step">JPG</span>CALIDAD AUTOMÁTICA 0.92 (SIN OBJETIVO) → <b>' + formatFileSize(blob.size) + '</b>');
    return { blob, quality: 0.92, blocker: null };
  }
  ui.setStatus(label, phase);
  const onPass = (q, size, ok, n) =>
    ui.log('<span class="log-step">P' + String(n).padStart(2, '0') + '</span>CALIDAD ' + q.toFixed(2) + ' → <b>' + formatFileSize(size) + '</b> ' +
      (ok ? '<span class="log-ok">DENTRO</span>' : '<span>EXCEDE</span>'));
  const r = await findBestQuality(src, dims.w, dims.h, 'image/jpeg', opts.bg, opts.target, onPass);
  return settleBinary(r, opts.target, 'JPG');
}

async function compressWebp(src, dims, opts, ui){
  if (!WEBP_OK) throw new Error('Tu navegador no codifica WebP — elige JPG o PNG como formato de salida.');
  const label = opts.converting ? 'CONVIRTIENDO A WEBP' : 'COMPRIMIENDO WEBP';
  const phase = opts.converting ? 'converting' : 'compressing';

  if (opts.mode === 'manual'){
    ui.setStatus(label, phase);
    const blob = await encodeImage(src, dims.w, dims.h, 'image/webp', opts.quality, null);
    ui.log('<span class="log-step">WEBP</span>CALIDAD MANUAL ' + opts.quality.toFixed(2) + ' → <b>' + formatFileSize(blob.size) + '</b>');
    return { blob, quality: opts.quality, blocker: null };
  }
  if (opts.target === null){
    ui.setStatus(label, phase);
    const blob = await encodeImage(src, dims.w, dims.h, 'image/webp', 0.92, null);
    ui.log('<span class="log-step">WEBP</span>CALIDAD AUTOMÁTICA 0.92 (SIN OBJETIVO) → <b>' + formatFileSize(blob.size) + '</b>');
    return { blob, quality: 0.92, blocker: null };
  }
  ui.setStatus(label, phase);
  const onPass = (q, size, ok, n) =>
    ui.log('<span class="log-step">P' + String(n).padStart(2, '0') + '</span>CALIDAD ' + q.toFixed(2) + ' → <b>' + formatFileSize(size) + '</b> ' +
      (ok ? '<span class="log-ok">DENTRO</span>' : '<span>EXCEDE</span>'));
  const r = await findBestQuality(src, dims.w, dims.h, 'image/webp', null, opts.target, onPass);
  return settleBinary(r, opts.target, 'WebP');
}

function settleBinary(r, target, fmtLabel){
  let best = r.best, blocker = null;
  if (!best){
    best = r.worst;
    blocker = 'No fue posible alcanzar ' + formatFileSize(target) + ' con estas dimensiones y ' + fmtLabel + '. Reduce las dimensiones, sube el objetivo o cambia de formato.';
  }
  return { blob: best.blob, quality: best.q, blocker };
}

async function findBestQuality(src, w, h, mime, bg, target, onPass){
  let lo = 0.3, hi = 1.0, best = null, worst = null, n = 0;
  let b = await encodeImage(src, w, h, mime, 1.0, bg); n++;
  onPass(1.0, b.size, b.size <= target, n);
  if (b.size <= target) return { best: { blob: b, q: 1 }, worst, passes: n };
  worst = { blob: b, q: 1 };
  while (hi - lo > 0.03){
    const mid = (lo + hi) / 2;
    b = await encodeImage(src, w, h, mime, mid, bg); n++;
    onPass(mid, b.size, b.size <= target, n);
    if (b.size <= target){ best = { blob: b, q: mid }; lo = mid; }
    else { hi = mid; if (b.size < worst.blob.size) worst = { blob: b, q: mid }; }
  }
  if (!best){
    b = await encodeImage(src, w, h, mime, 0.3, bg); n++;
    onPass(0.3, b.size, b.size <= target, n);
    if (b.size <= target) best = { blob: b, q: 0.3 };
    else if (b.size < worst.blob.size) worst = { blob: b, q: 0.3 };
  }
  return { best, worst, passes: n };
}

function mapError(e){
  const m = String(e && e.message || e);
  if (m === 'decode') return 'No fue posible leer esta imagen (archivo dañado o incompatible).';
  if (/codificaci|codificar|firma|WebP|PNG|JPG/i.test(m)) return m;
  return 'Error durante el procesamiento: ' + m;
}

/* ═════ §42 · processImage — LA FUNCIÓN MAESTRA ═════ */

async function processImage(item, cfg, override){
  override = override || {};
  item.status = 'working'; item.blocker = null; item.warns = []; item.logHTML = [];
  renderImageCard(item);

  const log = html => {
    const line = '<div class="log-line">' + html + '</div>';
    item.logHTML.push(line);
    if (item.refs && item.refs.log) item.refs.log.insertAdjacentHTML('beforeend', line);
  };

  let src = null;
  try {
    src = await loadImage(item.file);
    updateImageStatus(item, 'PREPARANDO', 'preparing');

    const dims = calculateOutputDimensions(item, cfg, override.forceMax);
    const userTarget = cfg.targetKB > 0 ? cfg.targetKB * 1024 : null;
    /* V2.4 · TECHO EFECTIVO: el objetivo real de compresión es el MENOR
       entre lo que pidió el usuario y el tamaño del archivo original.
       Sin objetivo → el propio original. Así el resultado NUNCA pesa
       más que la imagen de partida: convertir formato solo comprime. */
    const target = userTarget === null ? item.file.size
                 : Math.min(userTarget, item.file.size);
    const inMime = item.format || 'image/jpeg';
    const outMime = override.forceMime || getOutputFormat(item, cfg, dims.resized, userTarget);
    const converting = outMime !== inMime;

    const useBg = outMime === 'image/jpeg' ? getBackgroundColor(cfg) : null;
    if (item.alpha && outMime === 'image/jpeg')
      log('<span class="log-warn">JPG NO ADMITE TRANSPARENCIA — SE APLANA SOBRE ' + useBg.toUpperCase() + '</span>');
    else if (item.alpha)
      log('<span class="log-ok">TRANSPARENCIA CONSERVADA EN ' + formatImageFormat(outMime) + '</span>');

    const algo = outMime === 'image/png' ? 'OPTIMIZACIÓN PNG (PALETA + BÚSQUEDA DE COLORES)' : 'BÚSQUEDA BINARIA ' + formatImageFormat(outMime);
    log('<span class="log-step">CFG</span>' + formatImageFormat(inMime) + ' → ' + formatImageFormat(outMime) + ' · ' + dims.w + '×' + dims.h +
      (cfg.mode === 'manual' ? ' · CALIDAD MANUAL ' + Math.round(cfg.quality * 100) + '%'
        : (userTarget ? ' · OBJETIVO ≤ ' + formatFileSize(userTarget) + ' · TECHO EFECTIVO ≤ ' + formatFileSize(target)
                      : ' · SIN OBJETIVO · TECHO: NO SUPERAR EL ORIGINAL (' + formatFileSize(target) + ')')) +
      ' · ' + algo);

    /* target nunca es null en V2.4: siempre es min(objetivo, original) */
    if (cfg.mode === 'auto' && outMime === inMime && !dims.resized && item.file.size <= target){
      item.result = createResultObject(item, item.file, inMime, null, item.sw, item.sh, true);
      log('<span class="log-ok">EL ORIGINAL YA ESTÁ EN EL FORMATO ELEGIDO Y CUMPLE — SE ENTREGA SIN PÉRDIDA</span>');
      finishItem(item);
      return;
    }

    const ui = {
      log,
      setStatus: (label, phase) => updateImageStatus(item, label, phase || (converting ? 'converting' : 'compressing'))
    };
    const r = await compressImage(src, dims, outMime,
      { target, quality: cfg.quality, mode: cfg.mode, bg: useBg, converting }, ui);

    item.result = createResultObject(item, r.blob, outMime, r.quality, dims.w, dims.h, false);
    item.result.pngColors = r.pngColors || null;
    item.blocker = r.blocker || null;
    if (outMime === 'image/jpeg' && item.alpha)
      item.warns.push('El JPG no admite transparencia: las áreas transparentes se reemplazaron por el fondo seleccionado (' + useBg + ').');
    if (r.pngColors)
      item.warns.push('Cuantizado a paleta de ' + r.pngColors + ' colores (PNG-8) para alcanzar el objetivo. Revisa el resultado con el comparador; en fotografías con degradados suaves, WebP o JPG suelen verse mejor.');
    /* V2.4 · aviso honesto si el resultado supera al original
       (solo alcanzable en MODO MANUAL o en fallback con bloqueo) */
    if (r.blob.size > item.file.size)
      item.warns.push('El resultado (' + formatFileSize(r.blob.size) + ') pesa más que el original (' + formatFileSize(item.file.size) +
        '). El formato/calidad elegidos no permiten igualarlo: prueba MODO AUTOMÁTICO con objetivo, cambia a WebP/JPG o reduce dimensiones.');

    const qTxt = r.pngColors
      ? 'PNG-8 · ' + r.pngColors + ' COLORES'
      : (r.quality !== null ? 'CALIDAD ' + r.quality.toFixed(2) : 'SIN PÉRDIDA');
    log('<span class="log-result">RESULTADO · ' + formatImageFormat(outMime) + ' · ' + qTxt + ' · ' + formatFileSize(r.blob.size) + '</span>');
    finishItem(item);

  } catch (err){
    item.status = 'error';
    item.errorMsg = mapError(err);
    renderImageCard(item);
    updateQueueInfo();
  } finally {
    if (src && src.close) src.close();
  }
}

/* ═════ ETAPA 4 · PROCESAMIENTO MÚLTIPLE (§43) ═════ */

async function processBatch(){
  if (appState.processing) return;
  if (!appState.queue.length){
    showError('Selecciona al menos una imagen.');
    const dz = $('#dropZone');
    dz.scrollIntoView({ behavior: 'smooth', block: 'center' });
    dz.classList.add('flash');
    setTimeout(() => dz.classList.remove('flash'), 1300);
    return;
  }
  const cfg = readCfg();
  appState.queue.forEach(it => {
    if (it.resultUrl) URL.revokeObjectURL(it.resultUrl);
    it.result = null; it.warns = []; it.blocker = null; it.errorMsg = null; it.status = 'wait';
  });
  renderImageList();

  appState.processing = true;
  appState.progress = { idx: 0, total: appState.queue.length };
  appState.lastSummary = '';
  $('#settingsPanel').classList.add('locked');
  updateProgress();

  for (let i = 0; i < appState.queue.length; i++){
    appState.progress.idx = i + 1;
    updateProgress();
    await processImage(appState.queue[i], cfg);
    await nextFrame();
  }

  appState.processing = false;
  appState.progress = null;
  $('#settingsPanel').classList.remove('locked');

  const total = appState.queue.length;
  const done = appState.queue.filter(i => i.status === 'done').length;
  const warn = appState.queue.filter(i => i.status === 'done' && (i.blocker || i.warns.length)).length;
  const err  = appState.queue.filter(i => i.status === 'error').length;
  appState.lastSummary = total + ' IMÁGENES PROCESAS';
  appState.finalCounts = { done, warn, err };
  updateProgress();
  showSuccess(total + ' imágenes procesadas' + (err ? ' — ' + err + ' con error, revisa la cola' : ''));
}

function updateProgress(){
  const btn = $('#processButton'), lbl = $('#processButtonText');
  const q = appState.queue;
  const pend = q.filter(i => i.status === 'wait').length;
  const done = q.filter(i => i.status === 'done').length;
  const err  = q.filter(i => i.status === 'error').length;
  const sec = $('#progressSection');
  const ec = $('#errorCount');

  if (appState.processing){
    const { idx, total } = appState.progress;
    const finished = done + err;
    const pct = Math.round((idx - 1) / total * 100);
    btn.disabled = true; btn.classList.add('busy');
    lbl.textContent = 'PROCESANDO…';
    sec.hidden = false;
    $('#progressText').textContent = 'PROCESANDO ' + idx + ' DE ' + total;
    $('#progressPercentage').textContent = pct + ' %';
    $('#progressFill').style.width = pct + '%';
    $('#completedCount').textContent = 'COMPLETADAS: ' + finished;
    ec.textContent = 'ERRORES: ' + err;
    ec.classList.toggle('has-err', err > 0);
  } else {
    btn.classList.remove('busy'); btn.disabled = false;
    lbl.textContent = pend
      ? ((done ? 'REPROCESAR ' : 'PROCESAR ') + pend + (pend === 1 ? ' IMAGEN' : ' IMÁGENES'))
      : (done ? 'PROCESAR DE NUEVO' : 'PROCESAR IMÁGENES');
    if (appState.lastSummary){
      sec.hidden = false;
      $('#progressText').textContent = appState.lastSummary;
      $('#progressPercentage').textContent = '100 %';
      $('#progressFill').style.width = '100%';
      $('#completedCount').textContent = 'COMPLETADAS: ' + done + (appState.finalCounts && appState.finalCounts.warn ? ' · CON AVISO: ' + appState.finalCounts.warn : '');
      ec.textContent = 'ERRORES: ' + err;
      ec.classList.toggle('has-err', err > 0);
    } else {
      sec.hidden = true;
    }
  }
  $('#downloadAllButton').hidden = done < 2;
  $('#downloadAllButton').textContent = 'DESCARGAR TODO (' + done + ')';
}

function updateImageStatus(item, label, phase){
  if (item.refs && item.refs.status)
    item.refs.status.innerHTML = '<span class="status status-' + (phase || 'processing') + '">' + label + '</span>';
}

/* ═════ ETAPA 5 · RESULTADOS, NOMBRES, DESCARGAS, ZIP (§44–45) ═════ */

function createResultObject(item, blob, mime, q, w, h, passthrough){
  return {
    originalName: item.file.name, originalSize: item.file.size,
    originalFormat: item.format || 'image/jpeg', originalWidth: item.sw, originalHeight: item.sh,
    outputName: '', outputSize: blob.size, outputFormat: mime, outputWidth: w, outputHeight: h,
    reductionPercentage: passthrough ? 0 : calculateReduction(item.file.size, blob.size),
    quality: q, pngColors: null, blob, status: 'completed', passthrough
  };
}

function sizeLabel(kb){
  if (kb >= 1024){ const mb = +(kb / 1024).toFixed(1); return String(mb) + 'mb'; }
  return kb + 'kb';
}
function generateOutputFilename(item){
  const r = item.result;
  if (r.passthrough) return item.file.name;
  const base = item.file.name.replace(/\.[^.]+$/, '') || 'imagen';
  const inExt = extOf(item.format || 'image/jpeg');
  const outExt = extOf(r.outputFormat);
  if (outExt === inExt) return base + '_comprimido.' + outExt;
  if (appState.settings.mode === 'manual' || appState.settings.targetKB === 0)
    return base + '_convertido.' + outExt;
  return base + '_' + sizeLabel(appState.settings.targetKB) + '.' + outExt;
}

function finishItem(item){
  item.status = 'done';
  item.resultUrl = URL.createObjectURL(item.result.blob);
  item.result.outputName = generateOutputFilename(item);
  renderImageCard(item);
  updateQueueInfo();
}

function downloadBlob(blob, filename){
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
function downloadResult(item){
  downloadBlob(item.result.blob, item.result.outputName);
  showSuccess('Descargando ' + item.result.outputName);
}

/* ─── ZIP 100% nativo: STORE + CRC32 (reutilizado por el PNG-8) ─── */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++){
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes){
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = (CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8)) >>> 0;
  return (c ^ 0xFFFFFFFF) >>> 0;
}

async function createZip(entries){
  const enc = new TextEncoder();
  const d = new Date();
  const dosTime = ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xFFFF;
  const dosDate = (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xFFFF;

  const files = [];
  let total = 22;
  for (const e of entries){
    const nameBytes = enc.encode(e.name);
    const data = new Uint8Array(await e.blob.arrayBuffer());
    files.push({ nameBytes, data, crc: crc32(data), offset: 0 });
    total += 30 + nameBytes.length + data.length + 46 + nameBytes.length;
  }

  const buf = new ArrayBuffer(total);
  const view = new DataView(buf);
  const u8 = new Uint8Array(buf);
  let pos = 0;

  for (const f of files){
    f.offset = pos;
    view.setUint32(pos, 0x04034b50, true); pos += 4;
    view.setUint16(pos, 20, true);        pos += 2;
    view.setUint16(pos, 0x0800, true);    pos += 2;
    view.setUint16(pos, 0, true);         pos += 2;
    view.setUint16(pos, dosTime, true);   pos += 2;
    view.setUint16(pos, dosDate, true);   pos += 2;
    view.setUint32(pos, f.crc, true);     pos += 4;
    view.setUint32(pos, f.data.length, true); pos += 4;
    view.setUint32(pos, f.data.length, true); pos += 4;
    view.setUint16(pos, f.nameBytes.length, true); pos += 2;
    view.setUint16(pos, 0, true);         pos += 2;
    u8.set(f.nameBytes, pos); pos += f.nameBytes.length;
    u8.set(f.data, pos);      pos += f.data.length;
  }

  const cdStart = pos;
  for (const f of files){
    view.setUint32(pos, 0x02014b50, true); pos += 4;
    view.setUint16(pos, 20, true);        pos += 2;
    view.setUint16(pos, 20, true);        pos += 2;
    view.setUint16(pos, 0x0800, true);    pos += 2;
    view.setUint16(pos, 0, true);         pos += 2;
    view.setUint16(pos, dosTime, true);   pos += 2;
    view.setUint16(pos, dosDate, true);   pos += 2;
    view.setUint32(pos, f.crc, true);     pos += 4;
    view.setUint32(pos, f.data.length, true); pos += 4;
    view.setUint32(pos, f.data.length, true); pos += 4;
    view.setUint16(pos, f.nameBytes.length, true); pos += 2;
    view.setUint16(pos, 0, true);         pos += 2;
    view.setUint16(pos, 0, true);         pos += 2;
    view.setUint16(pos, 0, true);         pos += 2;
    view.setUint16(pos, 0, true);         pos += 2;
    view.setUint32(pos, 0, true);         pos += 4;
    view.setUint32(pos, f.offset, true);  pos += 4;
    u8.set(f.nameBytes, pos); pos += f.nameBytes.length;
  }
  const cdSize = pos - cdStart;

  view.setUint32(pos, 0x06054b50, true); pos += 4;
  view.setUint16(pos, 0, true);          pos += 2;
  view.setUint16(pos, 0, true);          pos += 2;
  view.setUint16(pos, files.length, true); pos += 2;
  view.setUint16(pos, files.length, true); pos += 2;
  view.setUint32(pos, cdSize, true);     pos += 4;
  view.setUint32(pos, cdStart, true);    pos += 4;
  view.setUint16(pos, 0, true);          pos += 2;

  return new Blob([buf], { type: 'application/zip' });
}

async function downloadAllResults(){
  const dones = appState.queue.filter(i => i.status === 'done' && i.result);
  if (!dones.length) return;
  const used = new Set();
  const entries = dones.map((it, i) => {
    let n = it.result.outputName;
    if (used.has(n)) n = (i + 1) + '_' + n;
    used.add(n);
    return { name: n, blob: it.result.blob };
  });
  try {
    const blob = await createZip(entries);
    const d = new Date(), p = x => String(x).padStart(2, '0');
    downloadBlob(blob, 'prensa_resultados_' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate() + '') + '_' + p(d.getHours()) + p(d.getMinutes()) + '.zip');
    showSuccess('ZIP con ' + dones.length + ' imágenes — generado íntegramente en tu navegador');
  } catch(_){
    dones.forEach((it, i) => setTimeout(() => downloadBlob(it.result.blob, it.result.outputName), i * 400));
    showWarning('No fue posible generar el ZIP — se descargan las imágenes una a una');
  }
}

/* ─── §46 · INTERFAZ DE CONFIGURACIÓN ─────────────────────────── */

function readCfg(){ return { ...appState.settings, bg: getBackgroundColor(appState.settings) }; }
function manualChange(){ appState.ddOn = false; $('#presetDomiDelis').classList.remove('on'); persistCfg(); }

function reflectTarget(){
  const el = $('#customSizeInput');
  el.value = appState.settings.targetKB > 0
    ? (appState.settings.unit === 'mb' ? String(+(appState.settings.targetKB / 1024).toFixed(2)) : String(appState.settings.targetKB))
    : '';
}
function updatePresets(){
  $$('.preset-button').forEach(b => b.classList.toggle('on', +b.dataset.kb === appState.settings.targetKB));
}
function updateNotes(){
  const s = appState.settings;
  $('#modeNote').textContent = s.mode === 'auto'
    ? 'La calidad se ajusta automáticamente para cumplir el objetivo con la mejor fidelidad posible (búsqueda binaria en JPG/WebP, paleta en PNG). Techo efectivo: el menor entre tu objetivo y el tamaño original — el resultado nunca pesa más que la imagen de partida.'
    : 'Calidad fija elegida por ti: el tamaño final dependerá de cada imagen (el objetivo de tamaño se ignora en este modo).';
  $('#fmtNote').textContent = {
    auto: WEBP_OK
      ? 'Automático: el sistema recomienda — WebP si hay que comprimir (conserva transparencia), PNG si hay transparencia sin WebP, y el original intacto si ya cumple el objetivo.'
      : 'Automático: tu navegador no codifica WebP, así que se usará JPG (o PNG si hay transparencia).',
    'image/jpeg': 'Tu elección manda: TODAS las imágenes se convierten a JPG real. JPG no admite transparencia → se aplica el fondo seleccionado. Compresión: búsqueda binaria de calidad.',
    'image/png':  'Tu elección manda: TODAS las imágenes se convierten a PNG real. Primero sin pérdida; si excede el techo (tu objetivo o el tamaño original, el menor), cuantización a paleta (PNG-8, tipo TinyPNG) buscando el máximo de colores que cumpla. Transparencia conservada.',
    'image/webp': WEBP_OK
      ? 'Tu elección manda: TODAS las imágenes se convierten a WebP real, con la transparencia conservada. Compresión: búsqueda binaria de calidad.'
      : 'Tu navegador no puede codificar WebP. Elige JPG o PNG.'
  }[s.format];
}
function updateJpgBackgroundUI(){
  const show = (appState.settings.format === 'image/jpeg' || appState.settings.format === 'auto');
  $('#jpgBackgroundSection').style.display = show ? '' : 'none';
  const n = appState.queue.filter(i => i.alpha).length;
  const box = $('#alphaNote');
  if (show && n > 0){
    $('#alphaNoteTxt').textContent = 'El formato JPG no admite transparencia. ' + n + ' imagen(es) de la cola la tienen: las áreas transparentes se reemplazarán por el fondo seleccionado.';
    box.hidden = false;
  } else box.hidden = true;
}
function updateCustomSizeUI(){
  reflectTarget();
  $('#customSizeUnit').value = appState.settings.unit;
  updatePresets();
}
function updateResizeUI(){
  $('#resizeEnabled').checked = appState.settings.resize;
  $('#keepAspectRatio').checked = appState.settings.keepRatio;
  $('#maxWidth').value = appState.settings.maxW;
  $('#maxHeight').value = appState.settings.maxH;
  $('#resizePanel').classList.toggle('dis', !appState.settings.resize);
}
function updateSettingsUI(){
  $$('.seg-btn[data-mode]').forEach(b => b.classList.toggle('on', b.dataset.mode === appState.settings.mode));
  $$('.fmt-btn').forEach(b => b.classList.toggle('on', b.dataset.fmt === appState.settings.format));
  $('#qualityWrap').classList.toggle('off', appState.settings.mode === 'auto');
  $('#qualityRange').value = Math.round(appState.settings.quality * 100);
  $('#qualityValue').firstChild.textContent = Math.round(appState.settings.quality * 100);
  const rb = document.querySelector('input[name="jpgBackgroundMode"][value="' + appState.settings.bgKind + '"]');
  if (rb) rb.checked = true;
  $('#jpgBackgroundColor').value = appState.settings.bgCustom;
  $('#swCustom').style.setProperty('--cc', appState.settings.bgCustom);
  $('#presetDomiDelis').classList.toggle('on', appState.ddOn);
  updateResizeUI(); updateCustomSizeUI(); updateNotes(); updateJpgBackgroundUI();
}

function validateTarget(){
  const el = $('#customSizeInput');
  const rawVal = String(el.value).trim();
  if (rawVal === ''){ appState.settings.targetKB = 0; updateCustomSizeUI(); manualChange(); return; }
  const raw = parseFloat(rawVal.replace(',', '.'));
  if (isNaN(raw) || raw <= 0){
    showError('Introduce un tamaño válido (número mayor que cero).');
    reflectTarget(); return;
  }
  let kb = appState.settings.unit === 'mb' ? raw * 1024 : raw;
  if (kb < 10){ showWarning('El mínimo es 10 KB.'); kb = 10; }
  if (kb > 20480){ showWarning('El máximo es 20 MB.'); kb = 20480; }
  appState.settings.targetKB = Math.round(kb);
  reflectTarget(); updatePresets(); manualChange();
}

function validateDim(input, key){
  const rawVal = String(input.value).trim();
  if (rawVal === ''){ appState.settings[key] = ''; return; }
  const raw = parseInt(rawVal, 10);
  if (isNaN(raw) || raw <= 0){
    showError('Introduce una dimensión válida (número entero de píxeles).');
    input.value = appState.settings[key];
    return;
  }
  let v = raw;
  if (v < 16){ showWarning('El mínimo es 16 px.'); v = 16; }
  if (v > 20000){ showWarning('El máximo es 20000 px.'); v = 20000; }
  appState.settings[key] = v;
  input.value = v;
  manualChange();
}

/* ─── RF-17 · COMPARADOR ORIGINAL / RESULTADO ─────────────────── */

const cmpEl = $('#cmp');
let cmpDrag = false;
function setX(pct){ cmpEl.style.setProperty('--x', pct + '%'); }
function onCmpMove(e){
  const r = cmpEl.getBoundingClientRect();
  setX(Math.min(100, Math.max(0, (e.clientX - r.left) / r.width * 100)));
}
cmpEl.addEventListener('pointerdown', e => { cmpDrag = true; cmpEl.setPointerCapture(e.pointerId); onCmpMove(e); });
cmpEl.addEventListener('pointermove', e => { if (cmpDrag) onCmpMove(e); });
['pointerup', 'pointercancel'].forEach(ev => cmpEl.addEventListener(ev, () => cmpDrag = false));

function openCompare(item){
  if (!item.result) return;
  $('#cmpA').src = item.resultUrl;
  $('#cmpB').src = item.previewUrl;
  $('#cmpName').textContent = item.file.name;
  $('#cmpSub').textContent = 'ORIGINAL ' + item.sw + '×' + item.sh + ' · ' + formatFileSize(item.file.size) +
    ' — RESULTADO ' + item.result.outputWidth + '×' + item.result.outputHeight + ' · ' + formatFileSize(item.result.outputSize) +
    (item.result.pngColors ? ' · PNG-8 · ' + item.result.pngColors + ' COLORES'
      : (item.result.quality !== null ? ' · CALIDAD ' + item.result.quality.toFixed(2) : ''));
  cmpEl.style.aspectRatio = item.sw + ' / ' + item.sh;
  setX(50);
  $('#modal').hidden = false;
  document.body.classList.add('lock');
}
function closeModal(){
  $('#modal').hidden = true;
  document.body.classList.remove('lock');
}

/* ─── §18 · INICIALIZACIÓN Y EVENTOS ──────────────────────────── */

function initializeSettings(){
  loadCfg();
  if (!WEBP_OK){
    const wb = $('.fmt-btn[data-fmt="image/webp"]');
    wb.disabled = true; wb.title = 'Tu navegador no codifica WebP';
    if (appState.settings.format === 'image/webp') appState.settings.format = 'auto';
  }
}

function bindEvents(){
  const dz = $('#dropZone'), dzMsg = $('#dropZoneMessage'), DROP_TXT = 'ARRASTRA TUS IMÁGENES AQUÍ';
  let dragDepth = 0;

  $('#selectFilesButton').addEventListener('click', e => { e.stopPropagation(); $('#fileInput').click(); });
  dz.addEventListener('click', () => $('#fileInput').click());
  $('#fileInput').addEventListener('change', handleFileSelection);
  dz.addEventListener('dragenter', e => { e.preventDefault(); dragDepth++; dz.classList.add('drag-over'); dzMsg.textContent = 'SUELTA PARA CARGAR'; });
  dz.addEventListener('dragover',  e => e.preventDefault());
  dz.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth){ dz.classList.remove('drag-over'); dzMsg.textContent = DROP_TXT; } });
  dz.addEventListener('drop', e => {
    e.preventDefault(); dragDepth = 0;
    dz.classList.remove('drag-over'); dzMsg.textContent = DROP_TXT;
    handleDrop(e);
  });
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop',     e => e.preventDefault());

  $$('.preset-button').forEach(b => b.addEventListener('click', () => {
    const kb = +b.dataset.kb;
    appState.settings.targetKB = kb;
    if (kb === 1024) appState.settings.unit = 'mb';
    else if (kb > 0) appState.settings.unit = 'kb';
    updateCustomSizeUI(); manualChange();
  }));

  $('#customSizeInput').addEventListener('change', validateTarget);
  $('#customSizeUnit').addEventListener('change', e => { appState.settings.unit = e.target.value; reflectTarget(); manualChange(); });

  $$('.seg-btn[data-mode]').forEach(b => b.addEventListener('click', () => {
    appState.settings.mode = b.dataset.mode;
    $$('.seg-btn[data-mode]').forEach(x => x.classList.toggle('on', x === b));
    $('#qualityWrap').classList.toggle('off', b.dataset.mode === 'auto');
    updateNotes(); manualChange();
  }));
  $('#qualityRange').addEventListener('input', e => {
    appState.settings.quality = (+e.target.value) / 100;
    $('#qualityValue').firstChild.textContent = e.target.value;
    manualChange();
  });

  $$('.fmt-btn').forEach(b => b.addEventListener('click', () => {
    if (b.disabled) return;
    appState.settings.format = b.dataset.fmt;
    $$('.fmt-btn').forEach(x => x.classList.toggle('on', x === b));
    updateNotes(); updateJpgBackgroundUI(); manualChange();
  }));

  document.querySelectorAll('input[name="jpgBackgroundMode"]').forEach(r =>
    r.addEventListener('change', e => { appState.settings.bgKind = e.target.value; manualChange(); }));
  $('#jpgBackgroundColor').addEventListener('input', e => {
    appState.settings.bgCustom = e.target.value;
    $('#swCustom').style.setProperty('--cc', e.target.value);
    manualChange();
  });

  $('#resizeEnabled').addEventListener('change', e => { appState.settings.resize = e.target.checked; updateResizeUI(); manualChange(); });
  $('#keepAspectRatio').addEventListener('change', e => { appState.settings.keepAspectRatio = e.target.checked; manualChange(); });
  $('#maxWidth').addEventListener('change',  e => validateDim(e.target, 'maxW'));
  $('#maxHeight').addEventListener('change', e => validateDim(e.target, 'maxH'));

  $('#presetDomiDelis').addEventListener('click', () => {
    appState.settings = { ...appState.settings, targetKB: 200, unit: 'kb', mode: 'auto', format: 'image/webp',
                          resize: true, maxW: 1200, maxH: 1200, keepRatio: true };
    appState.ddOn = true;
    updateSettingsUI(); persistCfg();
    showSuccess('Preset DomiDelis aplicado: WebP · ≤ 200 KB · máx 1200×1200 · proporción mantenida');
  });

  $('#processButton').addEventListener('click', processBatch);
  $('#clearAllButton').addEventListener('click', clearAllImages);
  $('#downloadAllButton').addEventListener('click', downloadAllResults);

  $('#imageList').addEventListener('click', e => {
    const b = e.target.closest('[data-act]');
    if (!b || !b.dataset.act) return;
    const item = appState.queue.find(i => i.id === b.closest('.image-card').dataset.id);
    if (!item) return;
    const act = b.dataset.act;
    if (act === 'remove' && !appState.processing) removeImage(item);
    if (act === 'download') downloadResult(item);
    if (act === 'compare') openCompare(item);
    if (act === 'retry' && !appState.processing) processImage(item, readCfg());
    if (act === 'fix-resize' && !appState.processing){
      showSuccess('Reprocesando con límite de 1600 px');
      processImage(item, readCfg(), { forceMax: { w: 1600, h: 1600 } });
    }
    if (act === 'fix-webp' && !appState.processing){
      showSuccess('Reprocesando como WebP');
      processImage(item, readCfg(), { forceMime: 'image/webp' });
    }
    if (act === 'fix-keep'){
      item.blocker = null;
      renderImageCard(item);
      showSuccess('Resultado mantenido');
    }
  });

  $('#modalClose').addEventListener('click', closeModal);
  $('#modalBack').addEventListener('click', closeModal);
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#modal').hidden) closeModal(); });
}

function initApp(){
  $('#today').textContent = 'HOY · ' + new Date()
    .toLocaleDateString('es-ES', { day: '2-digit', month: 'short', year: 'numeric' })
    .toUpperCase().replace(/\./g, '');
  initializeSettings();
  bindEvents();
  updateSettingsUI();
  if (!WEBP_OK) showWarning('Tu navegador no codifica WebP — la salida automática usará JPG/PNG.');
  if (!HAS_DEFLATE) showWarning('Este navegador no puede generar PNG de paleta: la compresión PNG agresiva no estará disponible.');
}
initApp();