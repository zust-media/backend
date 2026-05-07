import jwt from 'jsonwebtoken';

const JWT_SECRET = 'zustmedia_jwt_secret_key_2024_change_in_production';

export function generateToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
}

export function authenticate(req, res, next) {
  const authHeader = req.headers.authorization || '';

  const match = authHeader.match(/^Bearer\s+(.+)$/);
  if (!match) {
    req.user = null;
    return next();
  }

  try {
    const decoded = jwt.verify(match[1], JWT_SECRET);
    req.user = {
      user_id: decoded.user_id,
      uuid: decoded.uuid || '',
      username: decoded.username,
      role: decoded.role,
    };
  } catch {
    req.user = null;
  }
  next();
}

export function requireAuth(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: '未登录或登录已过期' });
  }
  next();
}

export function requireAdmin(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: '未登录或登录已过期' });
  }
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: '权限不足，仅管理员可操作' });
  }
  next();
}
