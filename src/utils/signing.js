import crypto from 'crypto';
import config from '../config/app.js';

const SIGNING_KEY = config.security.signingKey;

export function generateSig(filename, params = {}) {
  const filtered = {};
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') {
      filtered[k] = v;
    }
  }
  const paramString = Object.keys(filtered)
    .sort()
    .map((k) => `${k}=${filtered[k]}`)
    .join('&');

  const data = `${filename}${paramString}${SIGNING_KEY}`;
  return crypto.createHash('sha256').update(data).digest('hex').substring(0, 16);
}

export function verifySig(filename, params = {}, providedSig) {
  if (!providedSig) return false;
  return generateSig(filename, params) === providedSig;
}

export function generateSignedUrl(filename, baseUrl, params = {}) {
  const sig = generateSig(filename, params);
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    qs.append(k, String(v));
  }
  qs.append('s', sig);
  return `${baseUrl}?${qs.toString()}`;
}

export function requireValidSig(req, res, next) {
  const sig = req.query.s;
  const filename = req.params.filename;

  if (!sig) {
    return res.status(403).json({ error: '缺少签名参数 s' });
  }

  const params = { ...req.query };
  delete params.s;

  if (!verifySig(filename, params, sig)) {
    return res.status(403).json({ error: '签名验证失败' });
  }

  next();
}
