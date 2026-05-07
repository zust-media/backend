import { Router } from 'express';
import db from '../config/database.js';
import { generateSignedUrl } from '../utils/signing.js';
import { requireAdmin } from '../middleware/auth.js';
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
 *   description: 用户相关接口
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

router.get('/list', requireAdmin, (_req, res) => {
  const users = db.prepare(`
    SELECT u.id, u.username, u.role, u.uuid, u.slug, u.bio, u.created_at,
           COUNT(i.id) as image_count
    FROM users u
    LEFT JOIN images i ON i.user_id = u.id
    GROUP BY u.id
    ORDER BY u.id ASC
  `).all();

  res.json({ users });
});

router.put('/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  const { role } = req.body || {};

  if (!id) return res.status(400).json({ error: '无效的用户ID' });

  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(id);
  if (!user) return res.status(404).json({ error: '用户不存在' });

  if (role && !['admin', 'user'].includes(role)) {
    return res.status(400).json({ error: '无效的角色' });
  }

  if (role) {
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
  }

  res.json({ message: '用户已更新' });
});

router.delete('/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: '无效的用户ID' });

  const user = db.prepare('SELECT id, role FROM users WHERE id = ?').get(id);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  if (user.role === 'admin') return res.status(400).json({ error: '不能删除管理员账户' });

  const images = db.prepare('SELECT filename FROM images WHERE user_id = ?').all(id);
  for (const img of images) {
    const fp = join(uploadsDir, img.filename);
    if (existsSync(fp)) unlinkSync(fp);
  }

  db.prepare('DELETE FROM image_tags WHERE image_id IN (SELECT id FROM images WHERE user_id = ?)').run(id);
  db.prepare('DELETE FROM images WHERE user_id = ?').run(id);
  db.prepare('DELETE FROM users WHERE id = ?').run(id);

  res.json({ message: '用户已删除' });
});

router.get('/:identifier', (req, res) => {
  const identifier = (req.params.identifier || '').trim();
  if (!identifier) return res.status(400).json({ error: '无效的用户标识' });

  const user = db.prepare(`
    SELECT id, username, role, uuid, slug, bio, created_at FROM users
    WHERE uuid = ? OR slug = ?
  `).get(identifier, identifier);

  if (!user) return res.status(404).json({ error: '用户不存在' });

  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
  const offset = (page - 1) * limit;

  const total = db.prepare('SELECT COUNT(*) as count FROM images WHERE user_id = ?').get(user.id).count;
  const totalPages = Math.ceil(total / limit) || 1;

  const images = db.prepare(`
    SELECT * FROM images WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?
  `).all(user.id, limit, offset);

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
    images: images.map(formatImage),
    pagination: {
      page,
      limit,
      total,
      total_pages: totalPages,
    },
  });
});

export default router;
