import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import db from '../config/database.js';
import config from '../config/app.js';
import { validateNotBlocked } from '../config/blocked-keywords.js';
import { consumeRegToken } from '../config/captcha-store.js';
import { generateToken, requireAuth } from '../middleware/auth.js';
import { logUserUpdate } from '../utils/logger.js';

const CAPTCHA_JWT_SECRET = config.security.captchaJwtSecret;

/**
 * @swagger
 * tags:
 *   name: Auth
 *   description: 认证接口
 */
const router = Router();

/**
 * @swagger
 * /api/auth/register:
 *   post:
 *     tags: [Auth]
 *     summary: 用户注册
 *     description: >
 *       注册新用户。**必须先通过 `/api/auth/captcha/generate` 获取图形验证码，再通过 `/api/auth/captcha/verify` 验证后获取 regToken。**
 *       用户名 3-30 个字符，仅支持字母数字和下划线，密码至少 6 个字符。
 *       缺少 regToken 或 regToken 无效/已使用/已过期均返回 401。
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [username, password, regToken]
 *             properties:
 *               username:
 *                 type: string
 *                 description: 用户名（3-30字符，字母数字下划线）
 *               password:
 *                 type: string
 *                 minLength: 6
 *                 description: 密码（至少6个字符）
 *               regToken:
 *                 type: string
 *                 description: 通过 `/api/auth/captcha/verify` 获取的一次性注册令牌，有效期 15 分钟
 *     responses:
 *       201:
 *         description: 注册成功
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiMessage'
 *       400:
 *         description: 参数错误（用户名格式、密码长度、关键字屏蔽等）
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiError'
 *       401:
 *         description: regToken 缺失、无效、已过期或已被使用
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiError'
 */
router.post('/register', (req, res) => {
  const { username, password, regToken } = req.body;

  if (!regToken) {
    return res.status(401).json({ error: '未经授权的请求' });
  }

  let jti;
  try {
    const decoded = jwt.verify(regToken, CAPTCHA_JWT_SECRET);
    if (decoded.purpose !== 'registration') {
      return res.status(401).json({ error: '未经授权的请求' });
    }
    jti = decoded.jti;
  } catch {
    return res.status(401).json({ error: '未经授权的请求' });
  }

  if (!consumeRegToken(jti)) {
    return res.status(401).json({ error: '未经授权的请求' });
  }

  const name = (username || '').trim();

  if (name.length < 3 || name.length > 30) {
    return res.status(400).json({ error: '用户名长度需要3-30个字符' });
  }
  if (!/^[a-zA-Z0-9_]+$/.test(name)) {
    return res.status(400).json({ error: '用户名只能包含字母、数字和下划线' });
  }
  const blockedError = validateNotBlocked(name, '用户名');
  if (blockedError) return res.status(400).json({ error: blockedError });
  if (!password || password.length < 6) {
    return res.status(400).json({ error: '密码长度至少6个字符' });
  }

  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(name);
  if (existing) {
    return res.status(400).json({ error: '用户名已存在' });
  }

  const hashed = bcrypt.hashSync(password, 10);
  db.prepare('INSERT INTO users (username, password, role, uuid) VALUES (?, ?, ?, ?)').run(name, hashed, 'user', crypto.randomUUID());

  res.status(201).json({ message: '注册成功' });
});

/**
 * @swagger
 * /api/auth/login:
 *   post:
 *     tags: [Auth]
 *     summary: 用户登录
 *     description: 使用用户名和密码登录，返回 JWT Token 和用户信息
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [username, password]
 *             properties:
 *               username:
 *                 type: string
 *                 description: 用户名
 *               password:
 *                 type: string
 *                 description: 密码
 *     responses:
 *       200:
 *         description: 登录成功
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 token:
 *                   type: string
 *                   description: JWT Token
 *                 user:
 *                   $ref: '#/components/schemas/User'
 *       400:
 *         description: 参数错误
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiError'
 *       401:
 *         description: 用户名或密码错误
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiError'
 */
router.post('/login', (req, res) => {
  const { username, password } = req.body;
  const name = (username || '').trim();

  if (!name || !password) {
    return res.status(400).json({ error: '用户名和密码不能为空' });
  }

  const user = db.prepare('SELECT id, username, password, role, uuid, slug, bio, nickname FROM users WHERE username = ?').get(name);
  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.status(401).json({ error: '用户名或密码错误' });
  }

  const token = generateToken({
    user_id: user.id,
    uuid: user.uuid,
    username: user.username,
    role: user.role,
  });

  res.json({
    token,
    user: {
      id: user.id,
      uuid: user.uuid,
      username: user.username,
      nickname: user.nickname || '',
      role: user.role,
      slug: user.slug || '',
      bio: user.bio || '',
    },
  });
});

/**
 * @swagger
 * /api/auth/me:
 *   get:
 *     tags: [Auth]
 *     summary: 获取当前用户信息
 *     description: 返回当前已登录用户的详细信息
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: 当前用户信息
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 user:
 *                   $ref: '#/components/schemas/User'
 *       401:
 *         description: 未登录或Token无效
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiError'
 *       404:
 *         description: 用户不存在
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiError'
 */
router.get('/me', requireAuth, (req, res) => {
  const user = db.prepare('SELECT id, username, nickname, role, uuid, slug, bio, created_at FROM users WHERE id = ?').get(req.user.user_id);
  if (!user) return res.status(404).json({ error: '用户不存在' });

  res.json({
    user: {
      id: user.id,
      username: user.username,
      nickname: user.nickname || '',
      role: user.role,
      uuid: user.uuid,
      slug: user.slug || '',
      bio: user.bio || '',
      created_at: user.created_at,
    },
  });
});

/**
 * @swagger
 * /api/auth/profile:
 *   put:
 *     tags: [Auth]
 *     summary: 更新个人资料
 *     description: 修改当前用户的昵称、个性地址和个人简介
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               nickname:
 *                 type: string
 *                 maxLength: 50
 *                 description: 昵称
 *               bio:
 *                 type: string
 *                 maxLength: 200
 *                 description: 个人简介
 *     responses:
 *       200:
 *         description: 设置已保存
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message: { type: string }
 *                 bio: { type: string }
 *                 nickname: { type: string }
 *       400:
 *         description: 参数错误
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiError'
 *       401:
 *         description: 未登录
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiError'
 */
function isValidSlugForUser(slug) {
  if (!slug) return true;
  if (!/^[a-zA-Z0-9_-]+$/.test(slug)) return false;
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (uuidPattern.test(slug)) return false;
  return true;
}

router.put('/profile', requireAuth, (req, res) => {
  const { bio, nickname, slug } = req.body || {};
  const userId = req.user.user_id;

  const beforeUser = db.prepare('SELECT uuid, nickname, bio, slug FROM users WHERE id = ?').get(userId);
  const before = { nickname: beforeUser.nickname || '', bio: beforeUser.bio || '', slug: beforeUser.slug || '' };

  if (slug !== undefined) {
    const newSlug = (slug || '').trim();
    if (newSlug && !isValidSlugForUser(newSlug)) {
      return res.status(400).json({ error: '个性地址格式无效，不能使用纯数字或UUID格式' });
    }
    const blockedError = validateNotBlocked(newSlug, '个性地址');
    if (blockedError) return res.status(400).json({ error: blockedError });
    if (newSlug) {
      const dup = db.prepare('SELECT id FROM users WHERE slug = ? AND id != ?').get(newSlug, userId);
      if (dup) return res.status(400).json({ error: '该个性地址已被使用' });
    }
    db.prepare('UPDATE users SET slug = ? WHERE id = ?').run(newSlug || null, userId);
  }

  const newNickname = (nickname || '').trim().substring(0, 50);
  if (newNickname) {
    db.prepare('UPDATE users SET nickname = ? WHERE id = ?').run(newNickname, userId);
  }

  const newBio = (bio || '').trim().substring(0, 200);
  db.prepare('UPDATE users SET bio = ? WHERE id = ?').run(newBio, userId);

  const updatedUser = db.prepare('SELECT slug FROM users WHERE id = ?').get(userId);

  res.json({ message: '设置已保存', bio: newBio, nickname: newNickname, slug: updatedUser.slug || '' });

  const after = { nickname: newNickname, bio: newBio, slug: updatedUser.slug || '' };
  logUserUpdate(req, userId, beforeUser.uuid, before, after);
});

export default router;
