import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import db from '../config/database.js';
import { validateNotBlocked } from '../config/blocked-keywords.js';
import { generateSignedUrl } from '../utils/signing.js';
import { requireAdmin, isAdminRole } from '../middleware/auth.js';
import { logUserCreate, logUserUpdate, logUserDelete } from '../utils/logger.js';
import appConfig from '../config/app.js';
import { existsSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const uploadsDir = join(__dirname, '..', '..', 'uploads');

const router = Router();

/**
 * @swagger
 * tags:
 *   name: Users
 *   description: 用户管理（仅管理员）
 */

function getImageTags(imageId) {
  const rows = db.prepare(`
    SELECT t.id FROM tags t
    JOIN image_tags it ON t.id = it.tag_id
    WHERE it.image_id = ?
  `).all(imageId);
  return rows.map(r => r.id);
}

function formatImage(row) {
  let exif = {};
  try { exif = JSON.parse(row.exif || '{}'); } catch { /* ignore */ }

  const f = row.filename;
  const base = `/api/img/${f}`;

  const thumbnail_url = generateSignedUrl(f, base, {
    w: String(appConfig.thumbnail.defaultWidth),
    q: String(appConfig.thumbnail.defaultQuality),
  });

  const preview_url = generateSignedUrl(f, base, {
    w: String(appConfig.image.maxPreviewWidth),
    q: String(appConfig.image.defaultQuality),
  });

  const download_url = generateSignedUrl(f, base, {
    q: String(appConfig.image.defaultQuality),
    dl: '1',
  });

  return {
    id: row.id,
    uuid: row.uuid || '',
    uploader_uuid: row.uploader_uuid || '',
    filename: row.filename,
    original_name: row.original_name,
    mime_type: row.mime_type,
    file_size: row.file_size,
    title: row.title,
    description: row.description,
    category_id: row.category_id || null,
    tags: getImageTags(row.id),
    exif,
    thumbnail_url,
    preview_url,
    download_url,
    created_at: row.created_at,
    is_public: row.is_public || 0,
  };
}

function formatUser(row) {
  return {
    id: row.id,
    uuid: row.uuid || '',
    username: row.username,
    nickname: row.nickname || '',
    role: row.role,
    slug: row.slug || '',
    bio: row.bio || '',
    created_at: row.created_at,
  };
}

/**
 * @swagger
 * /api/users/list:
 *   get:
 *     tags: [Users]
 *     summary: 用户列表（管理员）
 *     description: 获取所有用户列表，包含每个用户上传的图片数量
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: 用户列表
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 users:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: integer }
 *                       uuid: { type: string }
 *                       username: { type: string }
 *                       nickname: { type: string }
 *                       role: { type: string }
 *                       bio: { type: string }
 *                       created_at: { type: string, format: date-time }
 *                       image_count: { type: integer }
 *       401:
 *         description: 未登录
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiError'
 *       403:
 *         description: 非管理员
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiError'
 */
router.get('/list', requireAdmin, (_req, res) => {
  const users = db.prepare(`
    SELECT u.*, COUNT(i.id) as image_count
    FROM users u
    LEFT JOIN images i ON i.user_id = u.id
    GROUP BY u.id
    ORDER BY u.id ASC
  `).all();

  res.json({
    users: users.map((u) => ({
      id: u.id,
      uuid: u.uuid,
      username: u.username,
      nickname: u.nickname || '',
      role: u.role,
      bio: u.bio || '',
      created_at: u.created_at,
      image_count: u.image_count,
    })),
  });
});

/**
 * @swagger
 * /api/users/create:
 *   post:
 *     tags: [Users]
 *     summary: 创建用户（管理员）
 *     description: 管理员创建新用户，可指定用户名、密码、角色等信息
 *     security: [{ bearerAuth: [] }]
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
 *                 description: 用户名（至少3个字符，字母数字下划线）
 *               password:
 *                 type: string
 *                 minLength: 6
 *                 description: 密码（至少6个字符）
 *               nickname:
 *                 type: string
 *                 description: 昵称
 *               role:
 *                 type: string
 *                 enum: [admin, super_admin, user]
 *                 default: user
 *                 description: 角色
 *     responses:
 *       201:
 *         description: 用户已创建
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message: { type: string }
 *                 user:
 *                   $ref: '#/components/schemas/User'
 *       400:
 *         description: 参数错误或用户名已存在
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
 *       403:
 *         description: 非管理员
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

router.post('/create', requireAdmin, (req, res) => {
  const { username, password, nickname, role, slug } = req.body || {};

  const name = (username || '').trim();
  if (!name) return res.status(400).json({ error: '用户名不能为空' });
  if (name.length < 3) return res.status(400).json({ error: '用户名至少3个字符' });
  if (!/^[a-zA-Z0-9_]+$/.test(name)) return res.status(400).json({ error: '用户名只能包含字母、数字和下划线' });

  const blockedError = validateNotBlocked(name, '用户名');
  if (blockedError) return res.status(400).json({ error: blockedError });

  if (!password || password.length < 6) return res.status(400).json({ error: '密码至少6个字符' });

  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(name);
  if (existing) return res.status(400).json({ error: '用户名已存在' });

  const userRole = role === 'admin' || role === 'super_admin' ? role : 'user';
  const userNickname = (nickname || '').trim();
  const hashed = bcrypt.hashSync(password, 10);
  const uuid = crypto.randomUUID();

  const userSlug = (slug || '').trim();
  if (userSlug) {
    if (!isValidSlugForUser(userSlug)) {
      return res.status(400).json({ error: '个性地址格式无效，不能使用纯数字或UUID格式' });
    }
    const slugBlocked = validateNotBlocked(userSlug, '个性地址');
    if (slugBlocked) return res.status(400).json({ error: slugBlocked });
    const slugDup = db.prepare('SELECT id FROM users WHERE slug = ?').get(userSlug);
    if (slugDup) return res.status(400).json({ error: '该个性地址已被使用' });
  }

  const result = db.prepare(
    'INSERT INTO users (username, password, role, uuid, nickname, slug) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(name, hashed, userRole, uuid, userNickname, userSlug || null);

  const user = db.prepare(
    'SELECT id, username, nickname, role, uuid, bio, created_at, slug FROM users WHERE id = ?'
  ).get(result.lastInsertRowid);

  res.status(201).json({ message: '用户已创建', user: formatUser(user) });
  logUserCreate(req, user);
});

/**
 * @swagger
 * /api/users/{uuid}:
 *   put:
 *     tags: [Users]
 *     summary: 更新用户（管理员）
 *     description: 管理员修改指定用户的信息（用户名、密码、昵称、角色等），通过用户UUID定位
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: uuid
 *         required: true
 *         schema: { type: string }
 *         description: 用户UUID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               username:
 *                 type: string
 *                 description: 新的用户名
 *               password:
 *                 type: string
 *                 minLength: 6
 *                 description: 新密码（至少6个字符）
 *               nickname:
 *                 type: string
 *                 description: 新的昵称
 *               role:
 *                 type: string
 *                 enum: [admin, super_admin, user]
 *                 description: 新的角色
 *     responses:
 *       200:
 *         description: 用户已更新
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message: { type: string }
 *                 user:
 *                   $ref: '#/components/schemas/User'
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
 *       403:
 *         description: 非管理员
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
router.put('/:uuid', requireAdmin, (req, res) => {
  const uuid = (req.params.uuid || '').trim();
  if (!uuid) return res.status(400).json({ error: '无效的用户UUID' });

  const existing = db.prepare('SELECT id, username, nickname, role, uuid, slug FROM users WHERE uuid = ?').get(uuid);
  if (!existing) return res.status(404).json({ error: '用户不存在' });
  const id = existing.id;

  const { username, password, nickname, role, slug } = req.body || {};

  const before = { username: existing.username, nickname: existing.nickname || '', role: existing.role, slug: existing.slug || '' };

  const updates = [];
  const params = [];

  if (username !== undefined) {
    const name = (username || '').trim();
    if (!name) return res.status(400).json({ error: '用户名不能为空' });
    if (name.length < 3) return res.status(400).json({ error: '用户名至少3个字符' });
    if (!/^[a-zA-Z0-9_]+$/.test(name)) return res.status(400).json({ error: '用户名只能包含字母、数字和下划线' });

    const blockedError = validateNotBlocked(name, '用户名');
    if (blockedError) return res.status(400).json({ error: blockedError });

    const dup = db.prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(name, id);
    if (dup) return res.status(400).json({ error: '用户名已存在' });
    updates.push('username = ?');
    params.push(name);
  }

  if (password !== undefined) {
    if (password.length < 6) return res.status(400).json({ error: '密码至少6个字符' });
    updates.push('password = ?');
    params.push(bcrypt.hashSync(password, 10));
  }

  if (nickname !== undefined) {
    const nick = (nickname || '').trim();
    const blockedError = validateNotBlocked(nick, '昵称');
    if (blockedError) return res.status(400).json({ error: blockedError });
    updates.push('nickname = ?');
    params.push(nick);
  }

  if (role !== undefined) {
    if (!['admin', 'super_admin', 'user'].includes(role)) return res.status(400).json({ error: '无效的角色' });
    updates.push('role = ?');
    params.push(role);
  }

  if (slug !== undefined) {
    const newSlug = (slug || '').trim();
    if (newSlug) {
      if (!isValidSlugForUser(newSlug)) {
        return res.status(400).json({ error: '个性地址格式无效，不能使用纯数字或UUID格式' });
      }
      const slugBlocked = validateNotBlocked(newSlug, '个性地址');
      if (slugBlocked) return res.status(400).json({ error: slugBlocked });
      const slugDup = db.prepare('SELECT id FROM users WHERE slug = ? AND id != ?').get(newSlug, id);
      if (slugDup) return res.status(400).json({ error: '该个性地址已被使用' });
    }
    updates.push('slug = ?');
    params.push(newSlug || null);
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: '没有需要更新的字段' });
  }

  params.push(id);
  db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params);

  const user = db.prepare(
    'SELECT id, username, nickname, role, uuid, bio, created_at, slug FROM users WHERE id = ?'
  ).get(id);

  res.json({ message: '用户已更新', user: formatUser(user) });

  const after = { username: user.username, nickname: user.nickname || '', role: user.role, slug: user.slug || '' };
  logUserUpdate(req, user.id, user.uuid, before, after);
});

/**
 * @swagger
 * /api/users/{uuid}:
 *   delete:
 *     tags: [Users]
 *     summary: 删除用户（管理员）
 *     description: 删除指定用户及其上传的所有图片。**超级管理员（role=super_admin）不可删除**，其他管理员账户可正常删除。通过用户UUID定位。
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: uuid
 *         required: true
 *         schema: { type: string }
 *         description: 用户UUID
 *     responses:
 *       200:
 *         description: 用户已删除
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiMessage'
 *       400:
 *         description: 参数错误或不可删除超级管理员
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
 *       403:
 *         description: 非管理员
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
router.delete('/:uuid', requireAdmin, (req, res) => {
  const uuid = (req.params.uuid || '').trim();
  if (!uuid) return res.status(400).json({ error: '无效的用户UUID' });

  const user = db.prepare('SELECT id, uuid, username, role FROM users WHERE uuid = ?').get(uuid);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  if (user.role === 'super_admin') return res.status(400).json({ error: '不能删除超级管理员账户' });

  const images = db.prepare('SELECT filename FROM images WHERE user_id = ?').all(user.id);
  for (const img of images) {
    const fp = join(uploadsDir, img.filename);
    if (existsSync(fp)) unlinkSync(fp);
  }

  db.prepare('DELETE FROM image_tags WHERE image_id IN (SELECT id FROM images WHERE user_id = ?)').run(user.id);
  db.prepare('DELETE FROM images WHERE user_id = ?').run(user.id);
  db.prepare('DELETE FROM users WHERE id = ?').run(user.id);

  res.json({ message: '用户已删除' });
  logUserDelete(req, user);
});

/**
 * @swagger
 * /api/users/lookup:
 *   get:
 *     tags: [Users]
 *     summary: 批量查询用户信息
 *     description: 通过逗号分隔的UUID列表批量查询用户基本信息（不含权限检查）
 *     parameters:
 *       - in: query
 *         name: uuids
 *         required: true
 *         schema: { type: string }
 *         description: 逗号分隔的用户UUID列表
 *     responses:
 *       200:
 *         description: 用户信息映射
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 users:
 *                   type: object
 *                   description: 以UUID为key的用户信息映射
 *                   additionalProperties:
 *                     type: object
 *                     properties:
 *                       uuid: { type: string }
 *                       username: { type: string }
 *                       nickname: { type: string }
 *                       slug: { type: string }
 */
router.get('/lookup', (_req, res) => {
  const uuidsParam = (_req.query.uuids || '').trim();
  if (!uuidsParam) return res.json({ users: {} });

  const uuids = uuidsParam.split(',').map(s => s.trim()).filter(Boolean);
  if (uuids.length === 0) return res.json({ users: {} });

  const placeholders = uuids.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT uuid, username, nickname, slug FROM users WHERE uuid IN (${placeholders})`
  ).all(...uuids);

  const users = {};
  for (const r of rows) {
    users[r.uuid] = { uuid: r.uuid, username: r.username, nickname: r.nickname || '', slug: r.slug || '' };
  }
  res.json({ users });
});

/**
 * @swagger
 * /api/users/{uuid}:
 *   get:
 *     tags: [Users]
 *     summary: 用户详情及上传图片
 *     description: 根据用户UUID或slug获取用户详情及其上传的图片列表（分页）
 *     parameters:
 *       - in: path
 *         name: uuid
 *         required: true
 *         schema: { type: string }
 *         description: 用户UUID或slug
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *         description: 页码
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20 }
 *         description: 每页数量（最大50）
 *     responses:
 *       200:
 *         description: 用户详情及图片
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 user:
 *                   $ref: '#/components/schemas/User'
 *                 images:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Image'
 *                 pagination:
 *                   $ref: '#/components/schemas/Pagination'
 *       400:
 *         description: 无效的用户标识
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
router.get('/:uuid', (req, res) => {
  const identifier = (req.params.uuid || '').trim();
  if (!identifier) return res.status(400).json({ error: '无效的用户标识' });

  let user = db.prepare(`
    SELECT id, username, nickname, role, uuid, slug, bio, created_at FROM users WHERE uuid = ?
  `).get(identifier);

  if (!user) {
    user = db.prepare(`
      SELECT id, username, nickname, role, uuid, slug, bio, created_at FROM users WHERE slug = ?
    `).get(identifier);
  }

  if (!user) return res.status(404).json({ error: '用户不存在' });

  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
  const offset = (page - 1) * limit;

  const total = db.prepare('SELECT COUNT(*) as count FROM images WHERE user_id = ?').get(user.id).count;
  const totalPages = Math.ceil(total / limit) || 1;

  let images;
  const isSelf = req.user && req.user.uuid === user.uuid;
  const isAdmin = req.user && isAdminRole(req.user.role);
  if (isSelf || isAdmin) {
    images = db.prepare(`
      SELECT i.*, u.uuid as uploader_uuid
      FROM images i JOIN users u ON i.user_id = u.id
      WHERE i.user_id = ? ORDER BY i.created_at DESC LIMIT ? OFFSET ?
    `).all(user.id, limit, offset);
  } else {
    images = db.prepare(`
      SELECT i.*, u.uuid as uploader_uuid
      FROM images i JOIN users u ON i.user_id = u.id
      WHERE i.user_id = ? AND i.is_public = 1 ORDER BY i.created_at DESC LIMIT ? OFFSET ?
    `).all(user.id, limit, offset);
  }

  res.json({
    user: formatUser(user),
    images: images.map(formatImage),
    pagination: { page, limit, total, total_pages: totalPages },
  });
});

export default router;
