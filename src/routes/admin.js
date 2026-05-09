import { Router } from 'express';
import crypto from 'crypto';
import db from '../config/database.js';
import { requireAdmin } from '../middleware/auth.js';

const router = Router();

/**
 * @swagger
 * tags:
 *   name: Admin
 *   description: 管理接口（仅管理员）
 */

/**
 * @swagger
 * /api/admin/stats:
 *   get:
 *     tags: [Admin]
 *     summary: 站点统计数据
 *     description: 获取站点总体统计数据，包括用户数、图片数、存储空间、最近上传和上传排行
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: 统计数据
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 totalUsers:
 *                   type: integer
 *                   description: 用户总数
 *                 totalImages:
 *                   type: integer
 *                   description: 图片总数
 *                 totalCategories:
 *                   type: integer
 *                   description: 分类总数
 *                 totalTags:
 *                   type: integer
 *                   description: 标签总数
 *                 totalSize:
 *                   type: integer
 *                   description: 已用存储空间（字节）
 *                 duplicateCount:
 *                   type: integer
 *                   description: 重复图片数量
 *                 recentImages:
 *                   type: array
 *                   description: 最近5张上传的图片
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: integer }
 *                       uuid: { type: string }
 *                       title: { type: string }
 *                       original_name: { type: string }
 *                       file_size: { type: integer }
 *                       created_at: { type: string, format: date-time }
 *                       uploader_uuid: { type: string }
 *                 topUploaders:
 *                   type: array
 *                   description: 上传排行榜（前5名）
 *                   items:
 *                     type: object
 *                     properties:
 *                       uuid: { type: string }
 *                       nickname: { type: string }
 *                       role: { type: string }
 *                       cnt: { type: integer, description: '上传数量' }
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
router.get('/stats', requireAdmin, (_req, res) => {
  const totalUsers = db.prepare('SELECT COUNT(*) as cnt FROM users').get().cnt;
  const totalImages = db.prepare('SELECT COUNT(*) as cnt FROM images').get().cnt;
  const totalCategories = db.prepare('SELECT COUNT(*) as cnt FROM categories').get().cnt;
  const totalTags = db.prepare('SELECT COUNT(*) as cnt FROM tags').get().cnt;

  const totalSize = db.prepare('SELECT SUM(file_size) as total FROM images').get().total || 0;
  const duplicateCount = db.prepare('SELECT COUNT(*) as cnt FROM images WHERE is_duplicate = 1').get().cnt;

  const recentImages = db.prepare(`
    SELECT i.id, i.uuid, i.title, i.original_name, i.file_size, i.created_at,
           u.uuid as uploader_uuid, u.nickname as uploader_nickname, u.username as uploader_username, u.slug as uploader_slug
    FROM images i JOIN users u ON i.user_id = u.id
    ORDER BY i.created_at DESC LIMIT 5
  `).all();

  const topUploaders = db.prepare(`
    SELECT u.uuid, u.nickname, u.username, u.slug, u.role, COUNT(i.id) as cnt
    FROM users u LEFT JOIN images i ON i.user_id = u.id
    GROUP BY u.id ORDER BY cnt DESC LIMIT 5
  `).all();

  res.json({
    totalUsers,
    totalImages,
    totalCategories,
    totalTags,
    totalSize,
    duplicateCount,
    recentImages,
    topUploaders,
  });
});

/**
 * @swagger
 * /api/admin/logs:
 *   get:
 *     tags: [Admin]
 *     summary: 操作日志列表
 *     description: 分页获取系统操作日志，可按操作类型过滤
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *         description: 页码
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 50 }
 *         description: 每页数量（最大100）
 *       - in: query
 *         name: action
 *         schema: { type: string }
 *         description: 按操作类型过滤
 *     responses:
 *       200:
 *         description: 日志列表
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 logs:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       uuid: { type: string }
 *                       operator_uuid: { type: string }
 *                       operator_username: { type: string }
 *                       operator_nickname: { type: string }
 *                       action: { type: string }
 *                       data: { type: object }
 *                       created_at: { type: string, format: date-time }
 *                 actions:
 *                   type: array
 *                   items: { type: string }
 *                 pagination:
 *                   $ref: '#/components/schemas/Pagination'
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
router.get('/logs', requireAdmin, (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
  const actionFilter = (req.query.action || '').trim();
  const offset = (page - 1) * limit;

  let whereClause = '';
  const params = [];
  if (actionFilter) {
    whereClause = 'WHERE a.action = ?';
    params.push(actionFilter);
  }

  const countRow = db.prepare(`SELECT COUNT(*) as total FROM activity_log a ${whereClause}`).get(...params);
  const total = countRow ? countRow.total : 0;

  const logs = db.prepare(`
    SELECT a.uuid, a.operator, a.action, a.data, a.created_at, u.username, u.nickname
    FROM activity_log a
    LEFT JOIN users u ON a.operator = u.uuid
    ${whereClause}
    ORDER BY a.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  const formatted = logs.map((row) => ({
    uuid: row.uuid,
    operator_uuid: row.operator,
    operator_username: row.username || 'unknown',
    operator_nickname: row.nickname || '',
    action: row.action,
    data: JSON.parse(row.data || '{}'),
    created_at: row.created_at,
  }));

  const actions = db.prepare('SELECT DISTINCT action FROM activity_log ORDER BY action').all().map(r => r.action);

  res.json({
    logs: formatted,
    actions,
    pagination: { page, limit, total, total_pages: Math.ceil(total / limit) || 1 },
  });
});

/**
 * @swagger
 * /api/admin/auth-codes:
 *   get:
 *     tags: [Admin]
 *     summary: 获取临时授权码列表
 *     description: 获取所有临时授权码及其使用情况
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: 授权码列表
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 codes:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: integer }
 *                       code: { type: string }
 *                       created_by: { type: string }
 *                       expires_at: { type: string, format: date-time }
 *                       max_uses: { type: integer, nullable: true }
 *                       use_count: { type: integer }
 *                       created_at: { type: string, format: date-time }
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
router.get('/auth-codes', requireAdmin, (_req, res) => {
  const rows = db.prepare(
    'SELECT id, code, created_by, expires_at, max_uses, use_count, created_at FROM temp_auth_codes ORDER BY created_at DESC'
  ).all();
  res.json({ codes: rows });
});

/**
 * @swagger
 * /api/admin/auth-codes:
 *   post:
 *     tags: [Admin]
 *     summary: 创建临时授权码
 *     description: 创建可临时访问 API 的授权码，用于分享链接等场景
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               hours:
 *                 type: integer
 *                 default: 24
 *                 description: 有效时长（小时）
 *               max_uses:
 *                 type: integer
 *                 nullable: true
 *                 description: 最大使用次数（不传则无限制）
 *     responses:
 *       201:
 *         description: 创建成功
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 code: { type: string, description: '授权码，格式为 tmp_xxxxxxxx' }
 *                 expires_at: { type: string, format: date-time }
 *                 max_uses: { type: integer, nullable: true }
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
router.post('/auth-codes', requireAdmin, (req, res) => {
  const { hours, max_uses } = req.body || {};
  const h = parseInt(hours) || 24;
  const expiresAt = new Date(Date.now() + h * 3600000).toISOString();
  const code = 'tmp_' + crypto.randomBytes(16).toString('hex');
  const creatorUuid = req.user?.uuid || '';

  db.prepare(
    'INSERT INTO temp_auth_codes (code, created_by, expires_at, max_uses) VALUES (?, ?, ?, ?)'
  ).run(code, creatorUuid, expiresAt, max_uses ? parseInt(max_uses) : null);

  res.status(201).json({
    code,
    expires_at: expiresAt,
    max_uses: max_uses ? parseInt(max_uses) : null,
  });
});

/**
 * @swagger
 * /api/admin/auth-codes/{id}:
 *   delete:
 *     tags: [Admin]
 *     summary: 删除临时授权码
 *     description: 删除指定的临时授权码
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *         description: 授权码ID
 *     responses:
 *       200:
 *         description: 删除成功
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message: { type: string }
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
 *         description: 授权码不存在
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiError'
 */
router.delete('/auth-codes/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  const row = db.prepare('SELECT id FROM temp_auth_codes WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: '授权码不存在' });
  db.prepare('DELETE FROM temp_auth_codes WHERE id = ?').run(id);
  res.json({ message: '授权码已删除' });
});

export default router;
