import sharp from 'sharp';
import { join, dirname } from 'path';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import config from '../config/app.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const IMG_CONFIG = config.image;
const WM_CONFIG = config.watermark;

function calcPosition(pos, iw, ih, ww, wh, mx, my) {
  if (pos === 'center') {
    return { left: Math.floor((iw - ww) / 2), top: Math.floor((ih - wh) / 2) };
  }
  let left = mx, top = my;
  if (pos.includes('right')) left = iw - ww - mx;
  else if (!pos.includes('left')) left = Math.floor((iw - ww) / 2);
  if (pos.includes('bottom')) top = ih - wh - my;
  else if (!pos.includes('top')) top = Math.floor((ih - wh) / 2);
  return { left, top };
}

const wmCache = new Map();

async function loadWatermark(watermarkFile) {
  const file = watermarkFile || IMG_CONFIG.defaultWatermark;
  if (wmCache.has(file)) return wmCache.get(file);

  const wmPath = join(__dirname, '..', '..', 'public', file);
  if (!existsSync(wmPath)) {
    console.warn(`Watermark file not found: ${wmPath}`);
    wmCache.set(file, null);
    return null;
  }
  try {
    const buf = await sharp(wmPath).toBuffer();
    const meta = await sharp(buf).metadata();
    const result = { buffer: buf, meta };
    wmCache.set(file, result);
    return result;
  } catch (err) {
    console.error('Failed to load watermark:', err.message);
    wmCache.set(file, null);
    return null;
  }
}

async function applyWatermark(imageBuf, meta, watermarkFile) {
  const wm = await loadWatermark(watermarkFile);
  if (!wm) return imageBuf;

  const mx = Math.floor(meta.width * WM_CONFIG.marginX);
  const my = Math.floor(meta.height * WM_CONFIG.marginY);
  const longestEdge = Math.max(meta.width, meta.height);
  const ww = Math.floor(longestEdge * WM_CONFIG.sizeRatio);
  const wh = Math.floor(ww * (wm.meta.height / wm.meta.width));

  const resized = await sharp(wm.buffer)
    .resize(ww, wh)
    .ensureAlpha(WM_CONFIG.opacity)
    .toBuffer();

  const { left, top } = calcPosition(WM_CONFIG.position, meta.width, meta.height, ww, wh, mx, my);

  return sharp(imageBuf)
    .composite([{ input: resized, left, top }])
    .toBuffer();
}

export async function generateThumbnail(filename, options = {}) {
  const { width, height, quality, noWatermark } = options;
  const actualWidth = width ?? config.thumbnail.defaultWidth;
  const actualQuality = quality ?? config.thumbnail.defaultQuality;

  const uploadsDir = join(__dirname, '..', '..', 'uploads');
  const filePath = join(uploadsDir, filename);

  if (!existsSync(filePath)) return null;

  try {
    let pipeline = sharp(filePath, { limitInputPixels: false });
    const meta = await pipeline.metadata();

    if (meta.format === 'svg') {
      return await sharp(filePath).toBuffer();
    }

    let buffer;
    if (height) {
      buffer = await pipeline
        .resize(actualWidth, height, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: actualQuality })
        .toBuffer();
    } else if (meta.width > actualWidth) {
      buffer = await pipeline
        .resize(actualWidth, null, { withoutEnlargement: true })
        .jpeg({ quality: actualQuality })
        .toBuffer();
    } else {
      buffer = await sharp(filePath, { limitInputPixels: false })
        .jpeg({ quality: actualQuality })
        .toBuffer();
    }

    if (!noWatermark) {
      const resizedMeta = await sharp(buffer).metadata();
      buffer = await applyWatermark(buffer, resizedMeta, null);
    }

    return buffer;
  } catch (err) {
    console.error('Thumbnail generation error:', err.message);
    return null;
  }
}

export async function serveImage(filename, params = {}) {
  const w = params.w !== undefined ? parseInt(params.w) || 0 : 0;
  const q = params.q !== undefined ? parseInt(params.q) || IMG_CONFIG.defaultQuality : IMG_CONFIG.defaultQuality;
  const m = params.m || null;

  const uploadsDir = join(__dirname, '..', '..', 'uploads');
  const filePath = join(uploadsDir, filename);

  if (!existsSync(filePath)) return null;

  try {
    const meta = await sharp(filePath, { limitInputPixels: false }).metadata();

    if (meta.format === 'svg') {
      return await sharp(filePath).toBuffer();
    }

    let pipeline = sharp(filePath, { limitInputPixels: false });
    let shouldResize = false;

    if (w > 0 && meta.width > w) {
      pipeline = pipeline.resize(w, null, {
        withoutEnlargement: true,
        fit: 'inside',
      });
      shouldResize = true;
    }

    const format = meta.format === 'png' ? 'png' : 'jpeg';
    if (format === 'png') {
      pipeline = pipeline.png({ quality: q });
    } else {
      pipeline = pipeline.jpeg({ quality: q });
    }

    let buffer = await pipeline.toBuffer();

    const needsWatermark = !!m || IMG_CONFIG.forceWatermark;
    if (needsWatermark) {
      const processedMeta = shouldResize ? await sharp(buffer).metadata() : meta;
      buffer = await applyWatermark(buffer, processedMeta, m || null);
    }

    return buffer;
  } catch (err) {
    console.error('Image processing error:', err.message);
    return null;
  }
}
