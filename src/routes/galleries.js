import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import { Archiver } from 'archiver';
import db from '../config/database.js';
import appConfig from '../config/app.js';
import { requireAuth } from '../middleware/auth.js';
import { generateSignedUrl } from '../utils/signing.js';
import {
  logGalleryCreate,
  logGalleryUpdate,
  logGalleryDelete,
  logGalleryAddImages,
  logGalleryRemoveImages,
} from '../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const uploadsDir = join(__dirname, '..', '..', 'uploads');

const router = Router();

function getUserUuid(req) {
  const row = db.prepare('SELECT uuid FROM users WHERE id = ?').get(req.user.user_id);
  return row ? row.uuid : null;
}

function resolveImageId(target) {
  const byUuid = db.prepare('SELECT id FROM images WHERE uuid = ?').get(target);
  if (byUuid) return byUuid.id;
  const byId = db.prepare('SELECT id FROM images WHERE id = ?').get(parseInt(target));
  return byId ? byId.id : null;
}

function resolveGallery(identifier, userUuid) {
  let row = db.prepare('SELECT * FROM galleries WHERE uuid = ?').get(identifier);
  if (!row && !isNaN(parseInt(identifier))) {
    row = db.prepare('SELECT * FROM galleries WHERE id = ?').get(parseInt(identifier));
  }
  if (!row) return null;
  if (!row.is_public && row.creator_uuid !== userUuid) return null;
  return row;
}

function getImageTags(imageId) {
  const rows = db.prepare(`
    SELECT t.id FROM tags t
    JOIN image_tags it ON t.id = it.tag_id
    WHERE it.image_id = ?
  `).all(imageId);
  return rows.map((r) => r.id);
}

function formatImage(row) {
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
    exif: {},
    thumbnail_url,
    preview_url,
    download_url,
    created_at: row.created_at,
  };
}

router.get('/', requireAuth, (req, res) => {
  const userUuid = getUserUuid(req);
  if (!userUuid) return res.status(401).json({ error: '未登录' });

  const rows = db.prepare(`
    SELECT g.*, (SELECT COUNT(*) FROM gallery_images gi WHERE gi.gallery_id = g.id) AS image_count
    FROM galleries g
    WHERE g.creator_uuid = ? OR g.is_public = 1
    ORDER BY g.updated_at DESC
  `).all(userUuid);

  res.json({ galleries: rows });
});

router.post('/', requireAuth, (req, res) => {
  const userUuid = getUserUuid(req);
  if (!userUuid) return res.status(401).json({ error: '未登录' });

  const { name, description, is_public } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: '名称不能为空' });
  }

  const uuid = uuidv4();
  const stmt = db.prepare(
    'INSERT INTO galleries (uuid, name, description, creator_uuid, is_public) VALUES (?, ?, ?, ?, ?)'
  );
  const result = stmt.run(uuid, name.trim(), (description || '').trim(), userUuid, is_public !== false ? 1 : 0);

  const gallery = db.prepare('SELECT * FROM galleries WHERE id = ?').get(result.lastInsertRowid);
  logGalleryCreate(req, gallery);
  res.status(201).json({ gallery });
});

router.post('/:uuid/images', requireAuth, (req, res) => {
  const userUuid = getUserUuid(req);
  const gallery = resolveGallery(req.params.uuid, userUuid);

  if (!gallery) return res.status(404).json({ error: '照片夹不存在' });
  if (gallery.creator_uuid !== userUuid) return res.status(403).json({ error: '无权操作此照片夹' });

  const { image_uuids } = req.body;
  if (!image_uuids || !Array.isArray(image_uuids) || image_uuids.length === 0) {
    return res.status(400).json({ error: '请提供图片UUID列表' });
  }

  const insertStmt = db.prepare(
    'INSERT OR IGNORE INTO gallery_images (gallery_id, image_id) VALUES (?, ?)'
  );

  const resolvedUuids = [];
  let added = 0;
  for (const target of image_uuids) {
    const imageId = resolveImageId(target);
    if (imageId) {
      const result = insertStmt.run(gallery.id, imageId);
      if (result.changes > 0) {
        added++;
        resolvedUuids.push(target);
      }
    }
  }

  db.prepare('UPDATE galleries SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(gallery.id);
  logGalleryAddImages(req, gallery.uuid, resolvedUuids);
  res.json({ message: `成功添加 ${added} 张图片`, added, skipped: image_uuids.length - added });
});

router.delete('/:uuid/images', requireAuth, (req, res) => {
  const userUuid = getUserUuid(req);
  const gallery = resolveGallery(req.params.uuid, userUuid);

  if (!gallery) return res.status(404).json({ error: '照片夹不存在' });
  if (gallery.creator_uuid !== userUuid) return res.status(403).json({ error: '无权操作此照片夹' });

  const { image_uuids } = req.body;
  if (!image_uuids || !Array.isArray(image_uuids) || image_uuids.length === 0) {
    return res.status(400).json({ error: '请提供图片UUID列表' });
  }

  const resolvedUuids = [];
  let removed = 0;
  for (const target of image_uuids) {
    const imageId = resolveImageId(target);
    if (imageId) {
      const result = db.prepare('DELETE FROM gallery_images WHERE gallery_id = ? AND image_id = ?').run(gallery.id, imageId);
      if (result.changes > 0) {
        removed++;
        resolvedUuids.push(target);
      }
    }
  }

  db.prepare('UPDATE galleries SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(gallery.id);
  logGalleryRemoveImages(req, gallery.uuid, resolvedUuids);
  res.json({ message: `成功移除 ${removed} 张图片`, removed });
});

router.get('/:uuid/download', requireAuth, (req, res) => {
  const userUuid = getUserUuid(req);
  const gallery = resolveGallery(req.params.uuid, userUuid);

  if (!gallery) return res.status(404).json({ error: '照片夹不存在' });

  const imageRows = db.prepare(`
    SELECT i.filename, i.original_name FROM images i
    INNER JOIN gallery_images gi ON gi.image_id = i.id
    WHERE gi.gallery_id = ?
    ORDER BY gi.added_at DESC
  `).all(gallery.id);

  if (imageRows.length === 0) {
    return res.status(400).json({ error: '照片夹中没有图片' });
  }

  const safeName = gallery.name.replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, '_');
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(safeName)}.zip"`);

  const archive = new Archiver('zip', { zlib: { level: 5 } });
  archive.on('error', (err) => {
    console.error('archiver error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: '打包失败' });
  });

  archive.pipe(res);

  const usedNames = new Map();
  for (const img of imageRows) {
    const filePath = join(uploadsDir, img.filename);
    if (!existsSync(filePath)) continue;

    let name = img.original_name || img.filename;
    if (usedNames.has(name)) {
      const count = usedNames.get(name) + 1;
      usedNames.set(name, count);
      const dotIdx = name.lastIndexOf('.');
      name = dotIdx > 0
        ? `${name.substring(0, dotIdx)}_${count}${name.substring(dotIdx)}`
        : `${name}_${count}`;
    } else {
      usedNames.set(name, 1);
    }

    archive.file(filePath, { name });
  }

  archive.finalize();
});

router.get('/:uuid', requireAuth, (req, res) => {
  const userUuid = getUserUuid(req);
  const gallery = resolveGallery(req.params.uuid, userUuid);

  if (!gallery) return res.status(404).json({ error: '照片夹不存在' });

  const page = parseInt(req.query.page) || 1;
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  const offset = (page - 1) * limit;

  const countRow = db.prepare(
    'SELECT COUNT(*) AS total FROM gallery_images WHERE gallery_id = ?'
  ).get(gallery.id);

  const imageRows = db.prepare(`
    SELECT i.*, u.uuid AS uploader_uuid FROM images i
    INNER JOIN gallery_images gi ON gi.image_id = i.id
    LEFT JOIN users u ON i.user_id = u.id
    WHERE gi.gallery_id = ?
    ORDER BY gi.added_at DESC
    LIMIT ? OFFSET ?
  `).all(gallery.id, limit, offset);

  res.json({
    gallery,
    images: imageRows.map(formatImage),
    pagination: {
      page,
      limit,
      total: countRow.total,
      total_pages: Math.ceil(countRow.total / limit),
    },
  });
});

router.put('/:uuid', requireAuth, (req, res) => {
  const userUuid = getUserUuid(req);
  const gallery = resolveGallery(req.params.uuid, userUuid);

  if (!gallery) return res.status(404).json({ error: '照片夹不存在' });
  if (gallery.creator_uuid !== userUuid) return res.status(403).json({ error: '无权修改此照片夹' });

  const before = { name: gallery.name, description: gallery.description, is_public: gallery.is_public };
  const { name, description, is_public } = req.body;

  const newName = name !== undefined ? name.trim() : gallery.name;
  if (!newName) return res.status(400).json({ error: '名称不能为空' });

  db.prepare(`
    UPDATE galleries SET name = ?, description = ?, is_public = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    newName,
    description !== undefined ? description.trim() : gallery.description,
    is_public !== undefined ? (is_public ? 1 : 0) : gallery.is_public,
    gallery.id
  );

  const updated = db.prepare('SELECT * FROM galleries WHERE id = ?').get(gallery.id);
  logGalleryUpdate(req, gallery.uuid, before, {
    name: updated.name, description: updated.description, is_public: updated.is_public,
  });
  res.json({ gallery: updated });
});

router.delete('/:uuid', requireAuth, (req, res) => {
  const userUuid = getUserUuid(req);
  const gallery = db.prepare('SELECT * FROM galleries WHERE uuid = ?').get(req.params.uuid);

  if (!gallery) return res.status(404).json({ error: '照片夹不存在' });
  if (gallery.creator_uuid !== userUuid) return res.status(403).json({ error: '无权删除此照片夹' });

  logGalleryDelete(req, gallery.uuid, gallery.name);
  db.prepare('DELETE FROM galleries WHERE id = ?').run(gallery.id);
  res.json({ message: '照片夹已删除' });
});

export default router;
