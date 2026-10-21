/* faceblur フロントエンド */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const tokenMeta = document.querySelector('meta[name="admin-token"]');
  const ADMIN_TOKEN = tokenMeta ? tokenMeta.content.trim() : '';

  const MAX_PREVIEW_W = 1280;   // 画面上の表示幅の上限
  const MAX_PREVIEW_H = 900;    // 画面上の表示高さの上限
  const DETECT_MAX_SIDE = 1600; // 顔検出に送る画像の長辺の上限
  const UNDO_LIMIT = 40;        // 筆画の履歴保持数

  const state = {
    images: [],      // {id, name, bitmap, width, height, faces, strokes, undo}
    currentId: null,
    mode: 'brush',   // brush / erase / select
    blur: 40,        // ぼかしの強さ (%)
    brush: 40,       // 筆の太さ (元の画像ピクセル)
    hide: false,     // 元画像と比較する
    drawing: false,
    pointerId: null,
    cursor: null,    // マウスの位置 (元の画像ピクセル)
    seq: 0,
  };

  const scratch = {};  // 再利用用の作業用キャンバス

  // ---------- 補助 ----------
  function withToken(extra) {
    const headers = Object.assign({}, extra || {});
    if (ADMIN_TOKEN) headers['X-Faceblur-Token'] = ADMIN_TOKEN;
    return headers;
  }

  async function api(path, options = {}) {
    const opts = Object.assign({}, options);
    opts.headers = withToken(opts.headers);
    opts.cache = 'no-store';
    const res = await fetch(path, opts);
    const text = await res.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch (_) { data = { error: text }; }
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  let toastTimer = null;
  function toast(message, kind) {
    const el = $('toast');
    el.textContent = message;
    el.classList.remove('is-err', 'is-ok');
    if (kind === 'err') el.classList.add('is-err');
    if (kind === 'ok') el.classList.add('is-ok');
    el.classList.add('is-show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('is-show'), 3600);
  }

  function current() {
    return state.images.find((img) => img.id === state.currentId) || null;
  }

  function baseName(name) {
    return (name || 'image').replace(/\.[^.]+$/, '') || 'image';
  }

  // ---------- 画像の読み込み ----------
  async function loadFiles(fileList) {
    const files = Array.from(fileList || []).filter((f) => /^image\//.test(f.type));
    if (!files.length) {
      toast('画像ファイルを選んでください', 'err');
      return;
    }
    for (const file of files) {
      try {
        const bitmap = await createImageBitmap(file);
        const img = {
          id: ++state.seq,
          name: file.name || 'image',
          bitmap: bitmap,
          width: bitmap.width,
          height: bitmap.height,
          faces: [],
          strokes: [],
          undo: [],
        };
        state.images.push(img);
        await detectFaces(img);
      } catch (err) {
        toast(`${file.name || '画像'}: ${err.message}`, 'err');
      }
    }
    if (state.images.length) {
      selectImage(state.images[state.images.length - 1].id);
      renderThumbs();
    }
  }

  function selectImage(id) {
    state.currentId = id;
    const img = current();
    if (!img) return;
    const canvas = $('canvas');
    const overlay = $('overlay');
    const cursor = $('cursor');
    const scale = previewScale(img);
    canvas.width = Math.max(1, Math.round(img.width * scale));
    canvas.height = Math.max(1, Math.round(img.height * scale));
    overlay.width = canvas.width;
    overlay.height = canvas.height;
    cursor.width = canvas.width;
    cursor.height = canvas.height;
    state.cursor = null;
    $('empty-hint').classList.add('is-hidden');
    render();
    renderFaces();
    renderThumbs();
  }

  function previewScale(img) {
    return Math.min(1, MAX_PREVIEW_W / img.width, MAX_PREVIEW_H / img.height);
  }

  // ---------- 顔検出 ----------
  async function detectFaces(img) {
    const scale = Math.min(1, DETECT_MAX_SIDE / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d').drawImage(img.bitmap, 0, 0, w, h);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
    if (!blob) throw new Error('画像を変換できませんでした');

    const data = await api('/api/detect', {
      method: 'POST',
      body: blob,
      headers: { 'Content-Type': 'image/jpeg' },
    });

    // 検出した座標は縮小画像のもの. 元画像の位置に戻す.
    const kx = img.width / (data.width || w);
    const ky = img.height / (data.height || h);
    img.faces = (data.faces || []).map((face, index) => ({
      id: `${img.id}-${index}`,
      x: face.x * kx,
      y: face.y * ky,
      w: face.w * kx,
      h: face.h * ky,
      score: face.score,
      active: true,
    }));
    return img.faces.length;
  }

  async function runDetect(img) {
    const button = $('btn-detect');
    button.classList.add('is-busy');
    try {
      const found = await detectFaces(img);
      toast(found ? `${found} 人の顔を検出しました` : '顔は見つかりませんでした', found ? 'ok' : '');
      if (img === current()) {
        render();
        renderFaces();
      }
    } catch (err) {
      toast(`顔検出に失敗しました: ${err.message}`, 'err');
    } finally {
      button.classList.remove('is-busy');
    }
  }

  // ---------- 描画 ----------
  function scratchCanvas(key, w, h) {
    let canvas = scratch[key];
    if (!canvas) {
      canvas = document.createElement('canvas');
      scratch[key] = canvas;
    }
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    return canvas;
  }

  function blurRadius(img) {
    // 強さ (%) を画像の短辺に対するぼかし半径 (px) に変換する.
    const base = Math.min(img.width, img.height);
    return Math.max(0.5, (state.blur / 100) * base * 0.06);
  }

  function featherRadius(img) {
    // マスクの縁をぼかして境目をтуруにする.
    return Math.max(1, Math.min(img.width, img.height) * 0.005);
  }

  function drawMask(ctx, img, scale) {
    const w = ctx.canvas.width;
    const h = ctx.canvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#fff';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // 自動検出した顔 (楕円で覆う)
    for (const face of img.faces) {
      if (!face.active) continue;
      const pad = Math.max(face.w, face.h) * 0.15;
      ctx.beginPath();
      ctx.ellipse(
        (face.x + face.w / 2) * scale,
        (face.y + face.h / 2) * scale,
        (face.w / 2 + pad) * scale,
        (face.h / 2 + pad) * scale,
        0,
        0,
        Math.PI * 2
      );
      ctx.fill();
    }

    // 筆でなぞった部分
    for (const stroke of img.strokes) {
      const points = stroke.points;
      if (!points.length) continue;
      ctx.beginPath();
      ctx.lineWidth = Math.max(1, stroke.size * scale);
      ctx.moveTo(points[0].x * scale, points[0].y * scale);
      if (points.length === 1) {
        ctx.lineTo(points[0].x * scale + 0.01, points[0].y * scale);
      } else {
        for (let i = 1; i < points.length; i += 1) {
          ctx.lineTo(points[i].x * scale, points[i].y * scale);
        }
      }
      ctx.stroke();
    }
  }

  function render() {
    const img = current();
    const canvas = $('canvas');
    const overlay = $('overlay');
    const cursor = $('cursor');
    if (!img) {
      canvas.width = 0;
      canvas.height = 0;
      overlay.width = 0;
      overlay.height = 0;
      cursor.width = 0;
      cursor.height = 0;
      return;
    }
    const w = canvas.width;
    const h = canvas.height;
    const scale = w / img.width;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(img.bitmap, 0, 0, w, h);

    if (!state.hide && state.blur > 0) {
      const layer = scratchCanvas('blur', w, h);
      const lctx = layer.getContext('2d');
      lctx.clearRect(0, 0, w, h);
      lctx.filter = `blur(${Math.max(0.5, blurRadius(img) * scale)}px)`;
      lctx.drawImage(img.bitmap, 0, 0, w, h);
      lctx.filter = 'none';

      const mask = scratchCanvas('mask', w, h);
      drawMask(mask.getContext('2d'), img, scale);

      // マスクの所だけぼかす.
      lctx.globalCompositeOperation = 'destination-in';
      lctx.filter = `blur(${Math.max(0.5, featherRadius(img) * scale)}px)`;
      lctx.drawImage(mask, 0, 0);
      lctx.filter = 'none';
      lctx.globalCompositeOperation = 'source-over';

      ctx.drawImage(layer, 0, 0);
    }

    drawOverlay(img, scale);
  }

  function drawOverlay(img, scale) {
    const overlay = $('overlay');
    const ctx = overlay.getContext('2d');
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    for (const face of img.faces) {
      ctx.lineWidth = 2;
      ctx.setLineDash(face.active ? [] : [6, 4]);
      ctx.strokeStyle = face.active ? 'rgba(56, 189, 248, 0.95)' : 'rgba(148, 163, 184, 0.75)';
      ctx.strokeRect(face.x * scale, face.y * scale, face.w * scale, face.h * scale);
    }
    ctx.setLineDash([]);
  }

  // ---------- 筆のカーソル ----------
  function drawCursor() {
    const canvas = $('cursor');
    const img = current();
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!img || !state.cursor || state.mode === 'select') return;

    const scale = canvas.width / img.width;
    const x = state.cursor.x * scale;
    const y = state.cursor.y * scale;
    const r = Math.max(2, (state.brush / 2) * scale);  // 筆の太さと同じ大きさ
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.10)';
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)';
    ctx.stroke();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
    ctx.stroke();
  }

  // ---------- 筆ツール ----------
  function toImageCoords(event) {
    const canvas = $('canvas');
    const rect = canvas.getBoundingClientRect();
    const img = current();
    if (!img || !rect.width) return { x: 0, y: 0 };
    return {
      x: ((event.clientX - rect.left) / rect.width) * img.width,
      y: ((event.clientY - rect.top) / rect.height) * img.height,
    };
  }

  function pushUndo(img) {
    img.undo.push(JSON.stringify(img.strokes));
    if (img.undo.length > UNDO_LIMIT) img.undo.shift();
  }

  function undo(img) {
    if (!img || !img.undo.length) {
      toast('取り消せる筆画がありません', 'err');
      return;
    }
    img.strokes = JSON.parse(img.undo.pop());
    render();
  }

  function eraseAt(img, point, radius) {
    const r2 = radius * radius;
    const kept = [];
    for (const stroke of img.strokes) {
      let run = [];
      for (const p of stroke.points) {
        const inside = (p.x - point.x) ** 2 + (p.y - point.y) ** 2 <= r2;
        if (inside) {
          if (run.length) kept.push({ size: stroke.size, points: run });
          run = [];
        } else {
          run.push(p);
        }
      }
      if (run.length) kept.push({ size: stroke.size, points: run });
    }
    img.strokes = kept;
  }

  function faceAt(img, point) {
    let found = null;
    for (const face of img.faces) {
      const pad = Math.max(face.w, face.h) * 0.1;
      const inside =
        point.x >= face.x - pad &&
        point.x <= face.x + face.w + pad &&
        point.y >= face.y - pad &&
        point.y <= face.y + face.h + pad;
      if (inside) found = face;
    }
    return found;
  }

  function toggleFace(face) {
    face.active = !face.active;
    render();
    renderFaces();
  }

  function onPointerDown(event) {
    const img = current();
    if (!img) return;
    const point = toImageCoords(event);
    state.cursor = point;
    drawCursor();
    if (state.mode === 'select') {
      const face = faceAt(img, point);
      if (face) {
        toggleFace(face);
        toast(face.active ? 'この顔にぼかします' : 'この顔のぼかしを解除しました');
      } else {
        toast('ぼかしを解除したい顔を選んでください', 'err');
      }
      return;
    }
    event.preventDefault();
    $('canvas').setPointerCapture(event.pointerId);
    state.drawing = true;
    state.pointerId = event.pointerId;
    pushUndo(img);
    if (state.mode === 'erase') {
      eraseAt(img, point, state.brush / 2);
    } else {
      img.strokes.push({ size: state.brush, points: [point] });
    }
    render();
  }

  function onPointerMove(event) {
    const img = current();
    if (!img) return;
    const point = toImageCoords(event);
    state.cursor = point;
    if (!state.drawing || event.pointerId !== state.pointerId) {
      drawCursor();
      return;
    }
    if (state.mode === 'erase') {
      eraseAt(img, point, state.brush / 2);
    } else {
      const stroke = img.strokes[img.strokes.length - 1];
      if (!stroke) return;
      const last = stroke.points[stroke.points.length - 1];
      if (Math.hypot(point.x - last.x, point.y - last.y) < 2) return;
      stroke.points.push(point);
    }
    render();
  }

  function onPointerUp(event) {
    if (event.pointerId !== state.pointerId) return;
    state.drawing = false;
    state.pointerId = null;
  }

  function onPointerLeave() {
    state.cursor = null;
    drawCursor();
  }

  // ---------- 検出した顔の一覧 ----------
  function renderFaces() {
    const list = $('faces-list');
    const img = current();
    list.textContent = '';
    if (!img) return;
    if (!img.faces.length) {
      const li = document.createElement('li');
      li.className = 'none';
      li.textContent = 'まだ顔を検出していません';
      list.append(li);
      return;
    }
    img.faces.forEach((face, index) => {
      const li = document.createElement('li');
      if (!face.active) li.classList.add('is-off');
      const label = document.createElement('span');
      label.textContent = `顔 ${index + 1} (${Math.round(face.score * 100)}%)`;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn btn-xs';
      button.textContent = face.active ? '解除' : 'ぼかす';
      button.addEventListener('click', () => toggleFace(face));
      li.append(label, button);
      list.append(li);
    });
  }

  function renderThumbs() {
    const box = $('thumbs');
    box.textContent = '';
    for (const img of state.images) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'thumb' + (img.id === state.currentId ? ' is-active' : '');
      button.title = img.name;
      const thumb = document.createElement('canvas');
      const size = 52;
      const scale = Math.min(size / img.width, size / img.height);
      thumb.width = Math.max(1, Math.round(img.width * scale));
      thumb.height = Math.max(1, Math.round(img.height * scale));
      thumb.getContext('2d').drawImage(img.bitmap, 0, 0, thumb.width, thumb.height);
      button.append(thumb);
      button.addEventListener('click', () => selectImage(img.id));
      box.append(button);
    }
  }

  // ---------- 保存 ----------
  function renderFullSize(img) {
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img.bitmap, 0, 0);
    if (!state.hide && state.blur > 0) {
      const layer = document.createElement('canvas');
      layer.width = img.width;
      layer.height = img.height;
      const lctx = layer.getContext('2d');
      lctx.filter = `blur(${blurRadius(img)}px)`;
      lctx.drawImage(img.bitmap, 0, 0);
      lctx.filter = 'none';

      const mask = document.createElement('canvas');
      mask.width = img.width;
      mask.height = img.height;
      drawMask(mask.getContext('2d'), img, 1);

      lctx.globalCompositeOperation = 'destination-in';
      lctx.filter = `blur(${featherRadius(img)}px)`;
      lctx.drawImage(mask, 0, 0);
      lctx.filter = 'none';
      lctx.globalCompositeOperation = 'source-over';

      ctx.drawImage(layer, 0, 0);
    }
    return canvas;
  }

  function save() {
    const img = current();
    if (!img) {
      toast('写真がありません', 'err');
      return;
    }
    const mime = $('format').value;
    const ext = mime === 'image/png' ? 'png' : 'jpg';
    const canvas = renderFullSize(img);
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          toast('保存できませんでした', 'err');
          return;
        }
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `${baseName(img.name)}-blur.${ext}`;
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
        toast('保存しました', 'ok');
      },
      mime,
      0.92
    );
  }

  // ---------- アップデート / 再起動 ----------
  const modal = $('modal');
  $('modal-close').addEventListener('click', () => modal.classList.add('is-hidden'));

  function openModal(title, body) {
    $('modal-title').textContent = title;
    $('modal-body').textContent = body;
    modal.classList.remove('is-hidden');
  }

  async function waitForService(timeoutMs) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      try {
        const res = await fetch('/api/health', { cache: 'no-store' });
        if (res.ok) return true;
      } catch (_) { /* 再起動中 */ }
      await new Promise((r) => setTimeout(r, 800));
    }
    return false;
  }

  $('btn-update').addEventListener('click', async () => {
    const btn = $('btn-update');
    btn.classList.add('is-busy');
    openModal('アップデート', '開始しています...');
    try {
      await api('/api/update', { method: 'POST' });
      let last = '';
      for (;;) {
        let status;
        try {
          status = await api('/api/update/status');
        } catch (_) {
          await new Promise((r) => setTimeout(r, 1200));
          continue;
        }
        const lines = [];
        (status.steps || []).forEach((s) => {
          const mark = { running: '…', done: '✓', error: '×' }[s.state] || '·';
          lines.push(`${mark} ${s.name}${s.output ? ` — ${s.output}` : ''}`);
        });
        const text = lines.join('\n') + (status.message ? `\n\n${status.message}` : '');
        if (text !== last) {
          $('modal-body').textContent = text;
          last = text;
        }
        if (status.state === 'error') {
          toast(status.message || 'アップデートに失敗しました', 'err');
          break;
        }
        if (status.state === 'done' || status.state === 'idle') {
          $('modal-body').textContent += '\n\n再起動しています...';
          const back = await waitForService(120000);
          toast(back ? 'アップデートが完了しました' : '再起動に時間がかかっています', back ? 'ok' : '');
          break;
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      btn.classList.remove('is-busy');
      setTimeout(() => modal.classList.add('is-hidden'), 1500);
    }
  });

  $('btn-restart').addEventListener('click', async () => {
    const btn = $('btn-restart');
    btn.classList.add('is-busy');
    try {
      await api('/api/restart', { method: 'POST' });
      toast('再起動しています...');
      const back = await waitForService(30000);
      if (back) {
        toast('再起動しました', 'ok');
        window.location.reload();
      } else {
        toast('再起動に時間がかかっています', '');
      }
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      btn.classList.remove('is-busy');
    }
  });

  // ---------- 操作 ----------
  const dropzone = $('dropzone');
  const fileInput = $('file-input');

  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      fileInput.click();
    }
  });
  fileInput.addEventListener('change', () => {
    loadFiles(fileInput.files);
    fileInput.value = '';
  });

  ['dragenter', 'dragover'].forEach((name) => {
    window.addEventListener(name, (event) => {
      event.preventDefault();
      dropzone.classList.add('is-over');
    });
  });
  ['dragleave', 'drop'].forEach((name) => {
    window.addEventListener(name, (event) => {
      event.preventDefault();
      if (name === 'dragleave' && event.relatedTarget) return;
      dropzone.classList.remove('is-over');
    });
  });
  window.addEventListener('drop', (event) => {
    event.preventDefault();
    if (event.dataTransfer && event.dataTransfer.files.length) {
      loadFiles(event.dataTransfer.files);
    }
  });

  const canvas = $('canvas');
  canvas.classList.add('is-brush');
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('pointerleave', onPointerLeave);

  const modes = {
    'mode-brush': {
      mode: 'brush',
      hint: 'ドラッグすると選んだ場所を手動でぼかします',
    },
    'mode-erase': {
      mode: 'erase',
      hint: 'ドラッグすると筆でなぞったぼかしを消します',
    },
    'mode-select': {
      mode: 'select',
      hint: '検出した顔をクリックするとぼかしを解除できます',
    },
  };
  Object.keys(modes).forEach((id) => {
    $(id).addEventListener('click', () => {
      Object.keys(modes).forEach((key) => $(key).classList.remove('is-active'));
      $(id).classList.add('is-active');
      state.mode = modes[id].mode;
      $('mode-hint').textContent = modes[id].hint;
      // 選択モードでは筆のカーソルは出さない
      canvas.classList.toggle('is-brush', state.mode !== 'select');
      drawCursor();
    });
  });

  const blurSlider = $('blur-slider');
  blurSlider.addEventListener('input', () => {
    state.blur = Number(blurSlider.value);
    $('blur-value').textContent = `${state.blur}%`;
    render();
  });

  const brushSlider = $('brush-slider');
  brushSlider.addEventListener('input', () => {
    state.brush = Number(brushSlider.value);
    $('brush-value').textContent = `${state.brush}px`;
    drawCursor();
  });

  $('chk-hide').addEventListener('change', (event) => {
    state.hide = event.target.checked;
    render();
  });

  $('btn-detect').addEventListener('click', () => {
    const img = current();
    if (!img) {
      toast('先に写真を選んでください', 'err');
      return;
    }
    runDetect(img);
  });

  $('btn-clear-faces').addEventListener('click', () => {
    const img = current();
    if (!img) return;
    img.faces.forEach((face) => { face.active = false; });
    render();
    renderFaces();
    toast('検出した顔のぼかしをすべて解除しました');
  });

  $('btn-undo').addEventListener('click', () => undo(current()));
  $('btn-clear-strokes').addEventListener('click', () => {
    const img = current();
    if (!img || !img.strokes.length) return;
    pushUndo(img);
    img.strokes = [];
    render();
  });

  $('btn-clear-cache').addEventListener('click', async () => {
    const btn = $('btn-clear-cache');
    btn.classList.add('is-busy');
    try {
      const data = await api('/api/cache/clear', { method: 'POST' });
      const removed = data.removed || 0;
      toast(
        removed ? `サーバーのキャッシュ画像を ${removed} 件削除しました` : 'キャッシュ画像はありません',
        'ok'
      );
    } catch (err) {
      toast(`キャッシュの削除に失敗しました: ${err.message}`, 'err');
    } finally {
      btn.classList.remove('is-busy');
    }
  });

  $('btn-save').addEventListener('click', save);

  // ---------- 起動時 ----------
  (async () => {
    try {
      const info = await api('/api/info');
      if (info.version_label) $('version').textContent = info.version_label;
      document.title = `${info.name || 'faceblur'} ${info.version_label || ''}`.trim();
      if (info.repo) $('btn-update').title = `${info.repo} から最新版に更新します`;
      if (info.model && !info.model.ready) {
        toast('顔検出モデルをダウンロードしています (初回だけ少しかかります)');
      }
    } catch (_) { /* オフラインでも画面は使える */ }
  })();

  renderFaces();
})();
