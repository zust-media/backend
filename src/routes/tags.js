import { Router } from 'express';
import db from '../config/database.js';
import { validateNotBlocked } from '../config/blocked-keywords.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { logTagCreate, logTagUpdate, logTagDelete } from '../utils/logger.js';
import { generateSignedUrl } from '../utils/signing.js';
import appConfig from '../config/app.js';

const router = Router();

/**
 * @swagger
 * tags:
 *   name: Tags
 *   description: 标签管理
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidTagOrCategorySlug(slug) {
  if (!slug) return true;
  if (!/^[a-zA-Z0-9-]+$/.test(slug)) return false;
  if (/^[0-9]+$/.test(slug)) return false;
  return true;
}

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

/**
 * @swagger
 * /api/tags/list:
 *   get:
 *     tags: [Tags]
 *     summary: 标签列表
 *     description: 获取所有标签列表，包含每个标签关联的图片数量，按图片数量降序排列
 *     responses:
 *       200:
 *         description: 标签列表
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 tags:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Tag'
 */
router.get('/list', (_req, res) => {
  const tags = db.prepare(`
    SELECT t.id, t.name, t.slug, COUNT(it.image_id) as image_count
    FROM tags t
    LEFT JOIN image_tags it ON t.id = it.tag_id
    GROUP BY t.id
    ORDER BY image_count DESC
  `).all();

  res.json({ tags });
});

/**
 * @swagger
 * /api/tags/{id}:
 *   get:
 *     tags: [Tags]
 *     summary: 标签详情及关联图片
 *     description: 根据标签ID或slug获取标签详情及其关联的图片列表
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         description: 标签ID（整数）或slug（字符串）
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
 *         description: 标签详情及图片
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 tag:
 *                   $ref: '#/components/schemas/Tag'
 *                 images:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Image'
 *                 pagination:
 *                   $ref: '#/components/schemas/Pagination'
 *       400:
 *         description: 无效的标签标识
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiError'
 *       404:
 *         description: 标签不存在
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiError'
 */
router.get('/:id', (req, res) => {
  const identifier = (req.params.id || '').trim();
  if (!identifier) return res.status(400).json({ error: '无效的标签标识' });

  let tag;
  const numericId = parseInt(identifier);
  if (!isNaN(numericId)) {
    tag = db.prepare('SELECT id, name, slug FROM tags WHERE id = ?').get(numericId);
  }
  if (!tag) {
    tag = db.prepare('SELECT id, name, slug FROM tags WHERE slug = ?').get(identifier);
  }
  if (!tag) return res.status(404).json({ error: '标签不存在' });

  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
  const offset = (page - 1) * limit;

  const total = db.prepare('SELECT COUNT(*) as count FROM image_tags WHERE tag_id = ?').get(tag.id).count;
  const totalPages = Math.ceil(total / limit) || 1;

  const rows = db.prepare(`
    SELECT i.*, u.uuid as uploader_uuid
    FROM images i
    JOIN users u ON i.user_id = u.id
    JOIN image_tags it ON it.image_id = i.id
    WHERE it.tag_id = ?
    ORDER BY i.created_at DESC LIMIT ? OFFSET ?
  `).all(tag.id, limit, offset);

  res.json({
    tag,
    images: rows.map(formatImage),
    pagination: { page, limit, total, total_pages: totalPages },
  });
});

/**
 * @swagger
 * /api/tags/create:
 *   post:
 *     tags: [Tags]
 *     summary: 创建标签（管理员）
 *     description: 创建一个新的标签
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name]
 *             properties:
 *               name:
 *                 type: string
 *                 description: 标签名称
 *               slug:
 *                 type: string
 *                 description: URL标识（可选，不能为纯数字）
 *     responses:
 *       201:
 *         description: 标签已创建
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message: { type: string }
 *                 id: { type: integer }
 *       400:
 *         description: 参数错误或标签已存在
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
router.post('/create', requireAdmin, (req, res) => {
  const { name, slug } = req.body || {};
  const tagName = (name || '').trim();
  if (!tagName) return res.status(400).json({ error: '标签名称不能为空' });

  const blockedName = validateNotBlocked(tagName, '标签名称');
  if (blockedName) return res.status(400).json({ error: blockedName });

  const existing = db.prepare('SELECT id FROM tags WHERE name = ?').get(tagName);
  if (existing) return res.status(400).json({ error: '标签已存在' });

  const tagSlug = (slug || '').trim();
  if (tagSlug) {
    if (!isValidTagOrCategorySlug(tagSlug)) {
      return res.status(400).json({ error: '标签Slug格式无效，不能使用纯数字' });
    }
    const slugBlocked = validateNotBlocked(tagSlug, '标签Slug');
    if (slugBlocked) return res.status(400).json({ error: slugBlocked });
    const slugDup = db.prepare('SELECT id FROM tags WHERE slug = ?').get(tagSlug);
    if (slugDup) return res.status(400).json({ error: '该标签Slug已被使用' });
  }

  const generatedSlug = tagSlug || (() => {
    const fromName = tagName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    if (fromName && /^[a-zA-Z]+[a-zA-Z0-9-]*$/.test(fromName) && !/^[0-9]+$/.test(fromName)) return fromName;
    return `tag-${Date.now()}`;
  })();

  const result = db.prepare('INSERT INTO tags (name, slug) VALUES (?, ?)').run(tagName, generatedSlug);
  res.status(201).json({ message: '标签已创建', id: result.lastInsertRowid, slug: generatedSlug });
  logTagCreate(req, tagName, generatedSlug);
});

/**
 * @swagger
 * /api/tags/{id}:
 *   put:
 *     tags: [Tags]
 *     summary: 更新标签（管理员）
 *     description: 修改指定标签的名称和/或slug
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *         description: 标签ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *                 description: 新的标签名称
 *               slug:
 *                 type: string
 *                 description: 新的URL标识（可选，不能为纯数字）
 *     responses:
 *       200:
 *         description: 标签已更新
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message: { type: string }
 *                 id: { type: integer }
 *       400:
 *         description: 参数错误或标签名/Slug已存在
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
 *         description: 标签不存在
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiError'
 */
router.put('/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: '无效的标签ID' });

  const tag = db.prepare('SELECT id, name, slug FROM tags WHERE id = ?').get(id);
  if (!tag) return res.status(404).json({ error: '标签不存在' });

  const { name, slug } = req.body || {};
  const before = { name: tag.name, slug: tag.slug || '' };

  const updates = [];
  const params = [];
  const after = { name: before.name, slug: before.slug };

  if (name !== undefined) {
    const tagName = (name || '').trim();
    if (!tagName) return res.status(400).json({ error: '标签名称不能为空' });
    const blockedName = validateNotBlocked(tagName, '标签名称');
    if (blockedName) return res.status(400).json({ error: blockedName });
    const existingName = db.prepare('SELECT id FROM tags WHERE name = ? AND id != ?').get(tagName, id);
    if (existingName) return res.status(400).json({ error: '标签名称已存在' });
    updates.push('name = ?');
    params.push(tagName);
    after.name = tagName;
  }

  if (slug !== undefined) {
    const newSlug = (slug || '').trim();
    if (newSlug) {
      if (!isValidTagOrCategorySlug(newSlug)) {
        return res.status(400).json({ error: '标签Slug格式无效，不能使用纯数字' });
      }
      const slugBlocked = validateNotBlocked(newSlug, '标签Slug');
      if (slugBlocked) return res.status(400).json({ error: slugBlocked });
      const slugDup = db.prepare('SELECT id FROM tags WHERE slug = ? AND id != ?').get(newSlug, id);
      if (slugDup) return res.status(400).json({ error: '该标签Slug已被使用' });
    }
    const finalSlug = newSlug || (() => {
      const fromName = after.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
      if (fromName && /^[a-zA-Z]+[a-zA-Z0-9-]*$/.test(fromName) && !/^[0-9]+$/.test(fromName)) return fromName;
      return `tag-${id}`;
    })();
    updates.push('slug = ?');
    params.push(finalSlug);
    after.slug = finalSlug;
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: '没有需要更新的字段' });
  }

  params.push(id);
  db.prepare(`UPDATE tags SET ${updates.join(', ')} WHERE id = ?`).run(...params);

  res.json({ message: '标签已更新', id });
  logTagUpdate(req, id, before.slug, before, after);
});

/**
 * @swagger
 * /api/tags/{id}:
 *   delete:
 *     tags: [Tags]
 *     summary: 删除标签（管理员）
 *     description: 删除指定标签及其所有图片关联
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *         description: 标签ID
 *     responses:
 *       200:
 *         description: 标签已删除
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiMessage'
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
 *         description: 标签不存在
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiError'
 */
router.delete('/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  const tag = db.prepare('SELECT id, name, slug FROM tags WHERE id = ?').get(id);
  if (!tag) return res.status(404).json({ error: '标签不存在' });

  db.prepare('DELETE FROM image_tags WHERE tag_id = ?').run(id);
  db.prepare('DELETE FROM tags WHERE id = ?').run(id);
  res.json({ message: '标签已删除' });
  logTagDelete(req, tag.name, tag.slug || '');
});

export default router;
