import { Router } from 'express';
import db from '../config/database.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { generateSignedUrl } from '../utils/signing.js';
import appConfig from '../config/app.js';

const router = Router();

/**
 * @swagger
 * tags:
 *   name: Categories
 *   description: 分类管理
 */

function getImageTags(imageId) {
  return db.prepare(`
    SELECT t.id, t.name, t.slug FROM tags t
    JOIN image_tags it ON t.id = it.tag_id
    WHERE it.image_id = ?
  `).all(imageId);
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
    user_id: row.user_id,
    uploader_name: row.uploader_name || '',
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
  };
}

router.get('/list', (_req, res) => {
  const categories = db.prepare(`
    SELECT c.*, COUNT(i.id) as image_count
    FROM categories c
    LEFT JOIN images i ON i.category_id = c.id
    GROUP BY c.id
    ORDER BY c.id ASC
  `).all();

  res.json({ categories });
});

router.get('/:slug', (req, res) => {
  const slug = (req.params.slug || '').trim();
  if (!slug) return res.status(400).json({ error: '无效的分类' });

  const category = db.prepare('SELECT * FROM categories WHERE slug = ?').get(slug);
  if (!category) return res.status(404).json({ error: '分类不存在' });

  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
  const offset = (page - 1) * limit;

  const total = db.prepare('SELECT COUNT(*) as count FROM images WHERE category_id = ?').get(category.id).count;
  const totalPages = Math.ceil(total / limit) || 1;

  const images = db.prepare(`
    SELECT i.*, u.username as uploader_name
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

router.post('/create', requireAdmin, (req, res) => {
  const { name, slug, description } = req.body || {};
  const catName = (name || '').trim();
  const catSlug = (slug || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');

  if (!catName) return res.status(400).json({ error: '分类名称不能为空' });
  if (!catSlug) return res.status(400).json({ error: '分类标识不能为空' });

  const existing = db.prepare('SELECT id FROM categories WHERE slug = ? OR name = ?').get(catSlug, catName);
  if (existing) return res.status(400).json({ error: '分类名称或标识已存在' });

  db.prepare('INSERT INTO categories (name, slug, description) VALUES (?, ?, ?)').run(catName, catSlug, description || '');

  res.status(201).json({ message: '分类已创建' });
});

router.put('/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  const { name, slug, description } = req.body || {};
  const catName = (name || '').trim();

  if (!catName) return res.status(400).json({ error: '分类名称不能为空' });

  const cat = db.prepare('SELECT * FROM categories WHERE id = ?').get(id);
  if (!cat) return res.status(404).json({ error: '分类不存在' });

  const existingName = db.prepare('SELECT id FROM categories WHERE name = ? AND id != ?').get(catName, id);
  if (existingName) return res.status(400).json({ error: '分类名称已存在' });

  const newSlug = (slug || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || cat.slug;
  const existingSlug = db.prepare('SELECT id FROM categories WHERE slug = ? AND id != ?').get(newSlug, id);
  if (existingSlug) return res.status(400).json({ error: '分类标识已存在' });

  db.prepare('UPDATE categories SET name = ?, slug = ?, description = ? WHERE id = ?').run(catName, newSlug, description || '', id);
  res.json({ message: '分类已更新' });
});

router.delete('/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  const cat = db.prepare('SELECT slug FROM categories WHERE id = ?').get(id);
  if (!cat) return res.status(404).json({ error: '分类不存在' });
  if (cat.slug === 'uncategorized') return res.status(400).json({ error: '默认分类不可删除' });

  db.prepare('DELETE FROM categories WHERE id = ?').run(id);
  res.json({ message: '分类已删除' });
});

export default router;
