const captchaStore = new Map();
const regTokenStore = new Map();

const CAPTCHA_TTL = 5 * 60 * 1000;
const REGTOKEN_TTL = 15 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of captchaStore) {
    if (entry.expiresAt <= now) captchaStore.delete(key);
  }
  for (const [key, entry] of regTokenStore) {
    if (entry.expiresAt <= now) regTokenStore.delete(key);
  }
}, 60 * 1000);

export function setCaptcha(key, answer) {
  captchaStore.set(key, { answer, expiresAt: Date.now() + CAPTCHA_TTL });
}

export function getCaptcha(key) {
  const entry = captchaStore.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    captchaStore.delete(key);
    return null;
  }
  return entry;
}

export function deleteCaptcha(key) {
  captchaStore.delete(key);
}

export function setRegToken(jti) {
  regTokenStore.set(jti, { expiresAt: Date.now() + REGTOKEN_TTL, used: false });
}

export function consumeRegToken(jti) {
  const entry = regTokenStore.get(jti);
  if (!entry) return false;
  if (entry.expiresAt <= Date.now() || entry.used) {
    regTokenStore.delete(jti);
    return false;
  }
  entry.used = true;
  regTokenStore.delete(jti);
  return true;
}

export function isValidRegToken(jti) {
  const entry = regTokenStore.get(jti);
  if (!entry) return false;
  if (entry.expiresAt <= Date.now()) {
    regTokenStore.delete(jti);
    return false;
  }
  return !entry.used;
}
