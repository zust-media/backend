import { Router } from 'express';
import db from '../config/database.js';
import { validateNotBlocked } from '../config/blocked-keywords.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { logCategoryCreate, logCategoryUpdate, logCategoryDelete } from '../utils/logger.js';
import { generateSignedUrl } from '../utils/signing.js';
import appConfig from '../config/app.js';

const router = Router();

/**
 * @swagger
 * tags:
 *   name: Categories
 *   description: 分类管理
 */

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
 * /api/categories/list:
 *   get:
 *     tags: [Categories]
 *     summary: 分类列表
 *     description: 获取所有分类列表，包含每个分类下的图片数量
 *     responses:
 *       200:
 *         description: 分类列表
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 categories:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Category'
 */
router.get('/list', (_req, res) => {
  const categories = db.prepare(`
    SELECT c.id, c.name, c.slug, c.description, COUNT(i.id) as image_count
    FROM categories c
    LEFT JOIN images i ON i.category_id = c.id
    GROUP BY c.id
    ORDER BY c.id ASC
  `).all();

  res.json({ categories });
});

/**
 * @swagger
 * /api/categories/{id}:
 *   get:
 *     tags: [Categories]
 *     summary: 分类详情及图片
 *     description: 根据分类ID或slug获取分类详情及其下的图片列表
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         description: 分类ID（整数）或slug（字符串）
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
 *         description: 分类详情及图片
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 category:
 *                   $ref: '#/components/schemas/Category'
 *                 images:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Image'
 *                 pagination:
 *                   $ref: '#/components/schemas/Pagination'
 *       400:
 *         description: 无效的分类标识
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiError'
 *       404:
 *         description: 分类不存在
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiError'
 */
router.get('/:id', (req, res) => {
  const identifier = (req.params.id || '').trim();
  if (!identifier) return res.status(400).json({ error: '无效的分类标识' });

  let category;
  const numericId = parseInt(identifier);
  if (!isNaN(numericId)) {
    category = db.prepare('SELECT id, name, slug, description FROM categories WHERE id = ?').get(numericId);
  }
  if (!category) {
    category = db.prepare('SELECT id, name, slug, description FROM categories WHERE slug = ?').get(identifier);
  }
  if (!category) return res.status(404).json({ error: '分类不存在' });

  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
  const offset = (page - 1) * limit;

  const total = db.prepare('SELECT COUNT(*) as count FROM images WHERE category_id = ?').get(category.id).count;
  const totalPages = Math.ceil(total / limit) || 1;

  const images = db.prepare(`
    SELECT i.*, u.uuid as uploader_uuid
    FROM images i JOIN users u ON i.user_id = u.id
    WHERE i.category_id = ?
    ORDER BY i.created_at DESC LIMIT ? OFFSET ?
  `).all(category.id, limit, offset);

  res.json({
    category,
    images: images.map(formatImage),
    pagination: { page, limit, total, total_pages: totalPages },
  });
});

/**
 * @swagger
 * /api/categories/create:
 *   post:
 *     tags: [Categories]
 *     summary: 创建分类（管理员）
 *     description: 创建一个新的图片分类
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
 *                 description: 分类名称
 *               slug:
 *                 type: string
 *                 description: URL标识（可选，不能为纯数字）
 *               description:
 *                 type: string
 *                 description: 分类描述
 *     responses:
 *       201:
 *         description: 分类已创建
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message: { type: string }
 *                 id: { type: integer }
 *       400:
 *         description: 参数错误或分类已存在
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
  const { name, slug, description } = req.body || {};
  const catName = (name || '').trim();

  if (!catName) return res.status(400).json({ error: '分类名称不能为空' });

  const blockedName = validateNotBlocked(catName, '分类名称');
  if (blockedName) return res.status(400).json({ error: blockedName });

  const existing = db.prepare('SELECT id FROM categories WHERE name = ?').get(catName);
  if (existing) return res.status(400).json({ error: '分类名称已存在' });

  const catSlug = (slug || '').trim();
  if (catSlug) {
    if (!isValidTagOrCategorySlug(catSlug)) {
      return res.status(400).json({ error: '分类Slug格式无效，不能使用纯数字' });
    }
    const slugBlocked = validateNotBlocked(catSlug, '分类Slug');
    if (slugBlocked) return res.status(400).json({ error: slugBlocked });
    const slugDup = db.prepare('SELECT id FROM categories WHERE slug = ?').get(catSlug);
    if (slugDup) return res.status(400).json({ error: '该分类Slug已被使用' });
  }

  const generatedSlug = catSlug || (() => {
    const fromName = catName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    if (fromName && /^[a-zA-Z]+[a-zA-Z0-9-]*$/.test(fromName) && !/^[0-9]+$/.test(fromName)) return fromName;
    return `category-${Date.now()}`;
  })();

  const result = db.prepare('INSERT INTO categories (name, slug, description) VALUES (?, ?, ?)').run(catName, generatedSlug, description || '');
  res.status(201).json({ message: '分类已创建', id: result.lastInsertRowid, slug: generatedSlug });

  logCategoryCreate(req, catName, generatedSlug);
});

/**
 * @swagger
 * /api/categories/{id}:
 *   put:
 *     tags: [Categories]
 *     summary: 更新分类（管理员）
 *     description: 修改指定分类的名称、slug或描述
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *         description: 分类ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *                 description: 新的分类名称
 *               slug:
 *                 type: string
 *                 description: 新的URL标识（可选，不能为纯数字）
 *               description:
 *                 type: string
 *                 description: 新的分类描述
 *     responses:
 *       200:
 *         description: 分类已更新
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message: { type: string }
 *                 id: { type: integer }
 *       400:
 *         description: 参数错误或分类名/Slug已存在
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
 *         description: 分类不存在
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiError'
 */
router.put('/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: '无效的分类ID' });

  const cat = db.prepare('SELECT id, name, slug, description FROM categories WHERE id = ?').get(id);
  if (!cat) return res.status(404).json({ error: '分类不存在' });

  const { name, slug, description } = req.body || {};
  const before = { name: cat.name, slug: cat.slug || '', description: cat.description || '' };

  const updates = [];
  const params = [];
  const after = { name: before.name, slug: before.slug, description: before.description };

  if (name !== undefined) {
    const catName = (name || '').trim();
    if (!catName) return res.status(400).json({ error: '分类名称不能为空' });
    const blockedName = validateNotBlocked(catName, '分类名称');
    if (blockedName) return res.status(400).json({ error: blockedName });
    const existingName = db.prepare('SELECT id FROM categories WHERE name = ? AND id != ?').get(catName, id);
    if (existingName) return res.status(400).json({ error: '分类名称已存在' });
    updates.push('name = ?');
    params.push(catName);
    after.name = catName;
  }

  if (slug !== undefined) {
    const newSlug = (slug || '').trim();
    if (newSlug) {
      if (!isValidTagOrCategorySlug(newSlug)) {
        return res.status(400).json({ error: '分类Slug格式无效，不能使用纯数字' });
      }
      const slugBlocked = validateNotBlocked(newSlug, '分类Slug');
      if (slugBlocked) return res.status(400).json({ error: slugBlocked });
      const slugDup = db.prepare('SELECT id FROM categories WHERE slug = ? AND id != ?').get(newSlug, id);
      if (slugDup) return res.status(400).json({ error: '该分类Slug已被使用' });
    }
    const finalSlug = newSlug || (() => {
      const fromName = after.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
      if (fromName && /^[a-zA-Z]+[a-zA-Z0-9-]*$/.test(fromName) && !/^[0-9]+$/.test(fromName)) return fromName;
      return `category-${id}`;
    })();
    updates.push('slug = ?');
    params.push(finalSlug);
    after.slug = finalSlug;
  }

  if (description !== undefined) {
    const desc = (description || '').trim();
    updates.push('description = ?');
    params.push(desc);
    after.description = desc;
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: '没有需要更新的字段' });
  }

  params.push(id);
  db.prepare(`UPDATE categories SET ${updates.join(', ')} WHERE id = ?`).run(...params);

  res.json({ message: '分类已更新', id });
  logCategoryUpdate(req, id, before.slug, before, after);
});

/**
 * @swagger
 * /api/categories/{id}:
 *   delete:
 *     tags: [Categories]
 *     summary: 删除分类（管理员）
 *     description: 删除指定分类（默认分类不可删除）
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *         description: 分类ID
 *     responses:
 *       200:
 *         description: 分类已删除
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiMessage'
 *       400:
 *         description: 默认分类不可删除
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
 *         description: 分类不存在
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiError'
 */
router.delete('/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  const cat = db.prepare('SELECT id, name, slug FROM categories WHERE id = ?').get(id);
  if (!cat) return res.status(404).json({ error: '分类不存在' });

  if (cat.slug === 'uncategorized') return res.status(400).json({ error: '默认分类不可删除' });

  db.prepare('UPDATE images SET category_id = 1 WHERE category_id = ?').run(id);
  db.prepare('DELETE FROM categories WHERE id = ?').run(id);
  res.json({ message: '分类已删除' });
  logCategoryDelete(req, cat.name, cat.slug || '');
});

export default router;
