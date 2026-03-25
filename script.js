const video = document.getElementById('video');
const overlayCanvas = document.getElementById('overlayCanvas');
const overlayCtx = overlayCanvas.getContext('2d');

const processingCanvas = document.createElement('canvas');
const processingCtx = processingCanvas.getContext('2d', { willReadFrequently: true });

const stickerImg = document.getElementById('stickerImg');
const msg = document.getElementById('msg');
const retryBtn = document.getElementById('retryBtn');

// 調整しやすい定数
const SCALE = 0.22;
const STEP = 4;
const MIN_GREEN_PIXELS = 12;
const FIT_SCALE = 1.05;
const HOLD_FRAMES = 14;

const POSITION_SMOOTHING = 0.14;
const SIZE_SMOOTHING = 0.12;
const ANGLE_SMOOTHING = 0.12;
const MIN_BOX_SIZE = 10;

// 回転安定化
const MIN_ASPECT_FOR_ROTATION = 1.05;
const MAX_ANGLE_STEP = Math.PI / 12;

// デバッグ表示（不要なら false）
const SHOW_DEBUG_BOX = false;

// 状態
let currentStream = null;
let rafId = null;
let videoFrameCallbackId = null;
let started = false;
let stickerReady = false;

let lastPose = null;
let lostFrames = 0;
let processingSizeKey = '';

// UI
function showMessage(text) {
  msg.textContent = text;
  msg.style.display = 'block';
}

function hideMessage() {
  msg.style.display = 'none';
}

function showRetry(text) {
  showMessage(text);
  retryBtn.style.display = 'block';
}

function hideRetry() {
  retryBtn.style.display = 'none';
}

// 共通
function resizeOverlay() {
  overlayCanvas.width = window.innerWidth;
  overlayCanvas.height = window.innerHeight;
}

function stopCamera() {
  if (currentStream) {
    currentStream.getTracks().forEach(track => track.stop());
    currentStream = null;
  }
  video.pause();
  video.srcObject = null;
}

function stopLoop() {
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }

  if (videoFrameCallbackId && 'cancelVideoFrameCallback' in video) {
    video.cancelVideoFrameCallback(videoFrameCallbackId);
    videoFrameCallbackId = null;
  }
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function normalizeAngle(angle) {
  while (angle > Math.PI) angle -= Math.PI * 2;
  while (angle < -Math.PI) angle += Math.PI * 2;
  return angle;
}

function shortestAngleDelta(a, b) {
  return normalizeAngle(b - a);
}

function lerpAngle(a, b, t) {
  const diff = shortestAngleDelta(a, b);
  return normalizeAngle(a + diff * t);
}

function clampAngleStep(prevAngle, nextAngle, maxStep) {
  const diff = shortestAngleDelta(prevAngle, nextAngle);
  const clamped = Math.max(-maxStep, Math.min(maxStep, diff));
  return normalizeAngle(prevAngle + clamped);
}

// 主軸の向きが曖昧な形でも、前回角度に近い候補を選ぶ
function alignAngleToPrevious(rawAngle, prevAngle) {
  const candidates = [
    rawAngle,
    rawAngle + Math.PI,
    rawAngle - Math.PI,
    rawAngle + Math.PI / 2,
    rawAngle - Math.PI / 2
  ].map(normalizeAngle);

  let best = candidates[0];
  let bestDiff = Math.abs(shortestAngleDelta(prevAngle, best));

  for (let i = 1; i < candidates.length; i++) {
    const diff = Math.abs(shortestAngleDelta(prevAngle, candidates[i]));
    if (diff < bestDiff) {
      best = candidates[i];
      bestDiff = diff;
    }
  }

  return best;
}

function smoothPose(pose) {
  if (!lastPose) {
    lastPose = pose;
    return pose;
  }

  let targetAngle = pose.angle;
  targetAngle = clampAngleStep(lastPose.angle, targetAngle, MAX_ANGLE_STEP);

  const smoothed = {
    cx: lerp(lastPose.cx, pose.cx, POSITION_SMOOTHING),
    cy: lerp(lastPose.cy, pose.cy, POSITION_SMOOTHING),
    width: lerp(lastPose.width, pose.width, SIZE_SMOOTHING),
    height: lerp(lastPose.height, pose.height, SIZE_SMOOTHING),
    angle: lerpAngle(lastPose.angle, targetAngle, ANGLE_SMOOTHING),
    rotationReliable: pose.rotationReliable
  };

  lastPose = smoothed;
  return smoothed;
}

// ステッカー画像
function loadSticker() {
  if (stickerImg.complete && stickerImg.naturalWidth > 0) {
    stickerReady = true;
    return;
  }

  stickerImg.addEventListener('load', () => {
    stickerReady = true;
    console.log('sticker image loaded');
  }, { once: true });

  stickerImg.addEventListener('error', () => {
    console.warn('pkpk.png の読み込みに失敗しました');
    showMessage('ステッカー画像を読み込めませんでした\nファイル名と場所を確認してください');
  }, { once: true });
}

// カメラ
async function waitFirstVideoFrame(videoEl) {
  if ('requestVideoFrameCallback' in videoEl) {
    await new Promise(resolve => {
      videoEl.requestVideoFrameCallback(() => resolve());
    });
  } else {
    await new Promise(resolve => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    });
  }
}

async function startCameraOnce() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error('このブラウザはカメラAPIに対応していません');
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: { ideal: 'environment' },
      width: { ideal: 1280 },
      height: { ideal: 720 }
    },
    audio: false
  });

  currentStream = stream;

  video.muted = true;
  video.autoplay = true;
  video.playsInline = true;
  video.setAttribute('muted', '');
  video.setAttribute('autoplay', '');
  video.setAttribute('playsinline', '');
  video.setAttribute('webkit-playsinline', '');

  video.srcObject = stream;

  await new Promise((resolve, reject) => {
    const ok = () => {
      cleanup();
      resolve();
    };

    const ng = () => {
      cleanup();
      reject(new Error('カメラ映像を読み込めませんでした'));
    };

    const cleanup = () => {
      video.removeEventListener('loadeddata', ok);
      video.removeEventListener('error', ng);
    };

    if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) {
      resolve();
      return;
    }

    video.addEventListener('loadeddata', ok, { once: true });
    video.addEventListener('error', ng, { once: true });
  });

  await video.play();
  await waitFirstVideoFrame(video);
}

// 座標変換
function getCoverRect(srcW, srcH, dstW, dstH) {
  const srcAspect = srcW / srcH;
  const dstAspect = dstW / dstH;

  let drawW, drawH, offsetX, offsetY;

  if (srcAspect > dstAspect) {
    drawH = dstH;
    drawW = dstH * srcAspect;
    offsetX = (dstW - drawW) / 2;
    offsetY = 0;
  } else {
    drawW = dstW;
    drawH = dstW / srcAspect;
    offsetX = 0;
    offsetY = (dstH - drawH) / 2;
  }

  return { drawW, drawH, offsetX, offsetY };
}

function mapPointToScreen(x, y) {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const cw = overlayCanvas.width;
  const ch = overlayCanvas.height;

  const { drawW, drawH, offsetX, offsetY } = getCoverRect(vw, vh, cw, ch);

  return {
    x: offsetX + (x / vw) * drawW,
    y: offsetY + (y / vh) * drawH
  };
}

// 緑判定
function isGreenPixel(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const sat = max - min;

  if (g < 45) return false;
  if (g < r + 12) return false;
  if (g < b + 12) return false;
  if (sat < 18) return false;

  return true;
}

// 緑検出
function detectGreen() {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return null;

  const pw = Math.max(1, Math.floor(vw * SCALE));
  const ph = Math.max(1, Math.floor(vh * SCALE));
  const sizeKey = `${pw}x${ph}`;

  if (processingSizeKey !== sizeKey) {
    processingCanvas.width = pw;
    processingCanvas.height = ph;
    processingSizeKey = sizeKey;
  }

  processingCtx.drawImage(video, 0, 0, pw, ph);
  const frame = processingCtx.getImageData(0, 0, pw, ph);
  const data = frame.data;

  let count = 0;
  let sumX = 0;
  let sumY = 0;
  const points = [];

  for (let y = 0; y < ph; y += STEP) {
    for (let x = 0; x < pw; x += STEP) {
      const i = (y * pw + x) * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];

      if (!isGreenPixel(r, g, b)) continue;

      points.push({ x, y });
      count++;
      sumX += x;
      sumY += y;
    }
  }

  if (count < MIN_GREEN_PIXELS) return null;

  const cx = sumX / count;
  const cy = sumY / count;

  let sxx = 0;
  let syy = 0;
  let sxy = 0;

  for (const p of points) {
    const dx = p.x - cx;
    const dy = p.y - cy;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }

  let angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);

  if (lastPose) {
    angle = alignAngleToPrevious(angle, lastPose.angle);
  }

  const ux = Math.cos(angle);
  const uy = Math.sin(angle);
  const vx = -Math.sin(angle);
  const vy = Math.cos(angle);

  let minU = Infinity;
  let maxU = -Infinity;
  let minV = Infinity;
  let maxV = -Infinity;

  for (const p of points) {
    const dx = p.x - cx;
    const dy = p.y - cy;

    const u = dx * ux + dy * uy;
    const v = dx * vx + dy * vy;

    if (u < minU) minU = u;
    if (u > maxU) maxU = u;
    if (v < minV) minV = v;
    if (v > maxV) maxV = v;
  }

  let width = maxU - minU;
  let height = maxV - minV;

  if (width < MIN_BOX_SIZE || height < MIN_BOX_SIZE) return null;

  const aspect = Math.max(width, height) / Math.max(1, Math.min(width, height));
  const rotationReliable = aspect >= MIN_ASPECT_FOR_ROTATION;

  if (!rotationReliable && lastPose) {
    angle = lastPose.angle;
  }

  const padW = Math.max(2, width * 0.06);
  const padH = Math.max(2, height * 0.06);

  width += padW * 2;
  height += padH * 2;

  const pose = {
    cx: cx / SCALE,
    cy: cy / SCALE,
    width: width / SCALE,
    height: height / SCALE,
    angle,
    rotationReliable
  };

  return smoothPose(pose);
}

// デバッグ枠
function drawDebugBox(pose) {
  const center = mapPointToScreen(pose.cx, pose.cy);

  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const cw = overlayCanvas.width;
  const ch = overlayCanvas.height;
  const { drawW, drawH } = getCoverRect(vw, vh, cw, ch);

  const scaleX = drawW / vw;
  const scaleY = drawH / vh;

  const w = pose.width * scaleX;
  const h = pose.height * scaleY;

  overlayCtx.save();
  overlayCtx.translate(center.x, center.y);
  overlayCtx.rotate(pose.angle);
  overlayCtx.strokeStyle = 'red';
  overlayCtx.lineWidth = 3;
  overlayCtx.strokeRect(-w / 2, -h / 2, w, h);
  overlayCtx.restore();
}

// 描画
function drawSticker(pose) {
  if (!stickerReady || !stickerImg.naturalWidth || !stickerImg.naturalHeight) return;

  const center = mapPointToScreen(pose.cx, pose.cy);

  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const cw = overlayCanvas.width;
  const ch = overlayCanvas.height;
  const { drawW, drawH } = getCoverRect(vw, vh, cw, ch);

  const scaleX = drawW / vw;
  const scaleY = drawH / vh;

  const detectedW = pose.width * scaleX;
  const detectedH = pose.height * scaleY;

  if (detectedW < 2 || detectedH < 2) return;

  const srcW = stickerImg.naturalWidth;
  const srcH = stickerImg.naturalHeight;
  const imgAspect = srcW / srcH;
  const boxAspect = detectedW / detectedH;

  let drawStickerW, drawStickerH;

  if (imgAspect > boxAspect) {
    drawStickerW = detectedW * FIT_SCALE;
    drawStickerH = drawStickerW / imgAspect;
  } else {
    drawStickerH = detectedH * FIT_SCALE;
    drawStickerW = drawStickerH * imgAspect;
  }

  overlayCtx.save();
  overlayCtx.translate(center.x, center.y);
  overlayCtx.rotate(pose.angle);
  overlayCtx.drawImage(
    stickerImg,
    -drawStickerW / 2,
    -drawStickerH / 2,
    drawStickerW,
    drawStickerH
  );
  overlayCtx.restore();
}

// フレーム処理
function processFrame() {
  overlayCtx.setTransform(1, 0, 0, 1, 0, 0);
  overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);

  if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) {
    const pose = detectGreen();

    if (pose) {
      lostFrames = 0;

      if (SHOW_DEBUG_BOX) {
        drawDebugBox(pose);
      }

      drawSticker(pose);
      hideMessage();
    } else if (lastPose && lostFrames < HOLD_FRAMES) {
      lostFrames++;

      if (SHOW_DEBUG_BOX) {
        drawDebugBox(lastPose);
      }

      drawSticker(lastPose);
    } else {
      lastPose = null;
      showMessage('緑をカメラに映してください');
    }
  }
}

function scheduleNextFrame() {
  if ('requestVideoFrameCallback' in video) {
    videoFrameCallbackId = video.requestVideoFrameCallback(() => {
      processFrame();
      scheduleNextFrame();
    });
  } else {
    rafId = requestAnimationFrame(() => {
      processFrame();
      scheduleNextFrame();
    });
  }
}

// 起動
async function initApp() {
  if (started) return;
  started = true;

  hideRetry();
  showMessage('カメラを起動しています…');

  try {
    resizeOverlay();
    loadSticker();
    await startCameraOnce();

    showMessage('緑をカメラに映してください');

    stopLoop();
    scheduleNextFrame();
  } catch (err) {
    console.error(err);
    started = false;
    showRetry('カメラを起動できませんでした\n再試行してください');
  }
}

// イベント
retryBtn.addEventListener('click', async () => {
  stopLoop();
  stopCamera();
  lastPose = null;
  lostFrames = 0;
  started = false;
  await initApp();
});

window.addEventListener('DOMContentLoaded', initApp);
window.addEventListener('resize', resizeOverlay);

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    stopLoop();
  } else {
    resizeOverlay();
    if (started) {
      stopLoop();
      scheduleNextFrame();
    }
  }
});

window.addEventListener('pagehide', () => {
  stopLoop();
  stopCamera();
});