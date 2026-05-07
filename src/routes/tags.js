import { Router } from 'express';
import db from '../config/database.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { generateSignedUrl } from '../utils/signing.js';
import appConfig from '../config/app.js';

const router = Router();

/**
 * @swagger
 * tags:
 *   name: Tags
 *   description: 标签管理
 */

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
    tags: [],
    exif,
    thumbnail_url,
    preview_url,
    download_url,
    created_at: row.created_at,
  };
}

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

router.get('/:identifier', (req, res) => {
  const identifier = (req.params.identifier || '').trim();
  if (!identifier) return res.status(400).json({ error: '无效的标签' });

  let tag = db.prepare('SELECT id, name, slug FROM tags WHERE slug = ?').get(identifier);
  if (!tag) {
    tag = db.prepare('SELECT id, name, slug FROM tags WHERE name = ?').get(identifier);
  }
  if (!tag) return res.status(404).json({ error: '标签不存在' });

  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
  const offset = (page - 1) * limit;

  const total = db.prepare(`
    SELECT COUNT(*) as count FROM image_tags WHERE tag_id = ?
  `).get(tag.id).count;
  const totalPages = Math.ceil(total / limit) || 1;

  const rows = db.prepare(`
    SELECT i.*, u.username as uploader_name
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

router.post('/create', requireAdmin, (req, res) => {
  const { name, slug } = req.body || {};
  const tagName = (name || '').trim();
  if (!tagName) return res.status(400).json({ error: '标签名称不能为空' });

  const existing = db.prepare('SELECT id FROM tags WHERE name = ?').get(tagName);
  if (existing) return res.status(400).json({ error: '标签已存在' });

  let tagSlug = (slug || '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  if (!tagSlug) {
    tagSlug = tagName.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  }
  const slugExists = db.prepare('SELECT id FROM tags WHERE slug = ?').get(tagSlug);
  if (slugExists) return res.status(400).json({ error: '标签标识已存在' });

  db.prepare('INSERT INTO tags (name, slug) VALUES (?, ?)').run(tagName, tagSlug);
  res.status(201).json({ message: '标签已创建', slug: tagSlug });
});

router.put('/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  const { name, slug } = req.body || {};
  const tagName = (name || '').trim();
  if (!tagName) return res.status(400).json({ error: '标签名称不能为空' });

  const tag = db.prepare('SELECT id, slug FROM tags WHERE id = ?').get(id);
  if (!tag) return res.status(404).json({ error: '标签不存在' });

  const existingName = db.prepare('SELECT id FROM tags WHERE name = ? AND id != ?').get(tagName, id);
  if (existingName) return res.status(400).json({ error: '标签名称已存在' });

  let tagSlug = (slug || '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  if (!tagSlug) tagSlug = tag.slug;

  const existingSlug = db.prepare('SELECT id FROM tags WHERE slug = ? AND id != ?').get(tagSlug, id);
  if (existingSlug) return res.status(400).json({ error: '标签标识已存在' });

  db.prepare('UPDATE tags SET name = ?, slug = ? WHERE id = ?').run(tagName, tagSlug, id);
  res.json({ message: '标签已更新', slug: tagSlug });
});

router.delete('/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  const tag = db.prepare('SELECT id FROM tags WHERE id = ?').get(id);
  if (!tag) return res.status(404).json({ error: '标签不存在' });

  db.prepare('DELETE FROM image_tags WHERE tag_id = ?').run(id);
  db.prepare('DELETE FROM tags WHERE id = ?').run(id);
  res.json({ message: '标签已删除' });
});

export default router;
