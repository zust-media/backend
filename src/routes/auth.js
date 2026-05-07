import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import db from '../config/database.js';
import { generateToken, requireAuth } from '../middleware/auth.js';

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
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [username, password]
 *             properties:
 *               username: { type: string }
 *               password: { type: string, minLength: 6 }
 *     responses:
 *       201: { description: 注册成功 }
 *       400: { description: 参数错误 }
 */
router.post('/register', (req, res) => {
  const { username, password } = req.body;
  const name = (username || '').trim();

  if (name.length < 3 || name.length > 30) {
    return res.status(400).json({ error: '用户名长度需要3-30个字符' });
  }
  if (!/^[a-zA-Z0-9_]+$/.test(name)) {
    return res.status(400).json({ error: '用户名只能包含字母、数字和下划线' });
  }
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
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [username, password]
 *             properties:
 *               username: { type: string }
 *               password: { type: string }
 *     responses:
 *       200:
 *         description: 登录成功
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 token: { type: string }
 *                 user: { $ref: '#/components/schemas/User' }
 *       401: { description: 用户名或密码错误 }
 */
router.post('/login', (req, res) => {
  const { username, password } = req.body;
  const name = (username || '').trim();

  if (!name || !password) {
    return res.status(400).json({ error: '用户名和密码不能为空' });
  }

  const user = db.prepare('SELECT id, username, password, role, uuid, slug, bio FROM users WHERE username = ?').get(name);
  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.status(401).json({ error: '用户名或密码错误' });
  }

  const token = generateToken({
    user_id: user.id,
    username: user.username,
    role: user.role,
  });

  res.json({
    token,
    user: {
      id: user.id,
      username: user.username,
      role: user.role,
      uuid: user.uuid,
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
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: 当前用户信息 }
 *       401: { description: 未登录 }
 */
router.get('/me', requireAuth, (req, res) => {
  const user = db.prepare('SELECT id, username, role, uuid, slug, bio, created_at FROM users WHERE id = ?').get(req.user.user_id);
  if (!user) return res.status(404).json({ error: '用户不存在' });

  res.json({
    user: {
      id: user.id,
      username: user.username,
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
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               slug: { type: string, maxLength: 40 }
 *               bio: { type: string, maxLength: 200 }
 *     responses:
 *       200: { description: 设置已保存 }
 */
router.put('/profile', requireAuth, (req, res) => {
  const { slug, bio } = req.body || {};
  const userId = req.user.user_id;

  const newSlug = (slug || '').trim();
  if (newSlug && !/^[a-zA-Z0-9_-]+$/.test(newSlug)) {
    return res.status(400).json({ error: '个性地址只能包含字母、数字、连字符和下划线' });
  }
  if (newSlug && newSlug.length > 40) {
    return res.status(400).json({ error: '个性地址长度不能超过 40 个字符' });
  }

  if (newSlug) {
    const existing = db.prepare('SELECT id FROM users WHERE slug = ? AND id != ?').get(newSlug, userId);
    if (existing) {
      return res.status(400).json({ error: '该个性地址已被使用' });
    }
  }

  const newBio = (bio || '').trim().substring(0, 200);
  db.prepare('UPDATE users SET slug = ?, bio = ? WHERE id = ?').run(newSlug || null, newBio, userId);

  res.json({ message: '设置已保存', slug: newSlug || null, bio: newBio });
});

export default router;
