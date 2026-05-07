import { Router } from 'express';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import { extname, basename } from 'path';
import { existsSync, unlinkSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import exifr from 'exifr';
import db from '../config/database.js';
import appConfig from '../config/app.js';
import { requireAuth } from '../middleware/auth.js';
import { generateSignedUrl } from '../utils/signing.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const uploadsDir = join(__dirname, '..', '..', 'uploads');

const ALLOWED_TYPES = appConfig.allowedTypes;
const MAX_SIZE = appConfig.maxFileSizeMB * 1024 * 1024;
const MAX_BATCH = appConfig.maxBatchCount;

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => {
    const ext = extname(file.originalname).toLowerCase();
    cb(null, `${uuidv4()}${ext}`);
  },
});

const fileFilter = (_req, file, cb) => {
  if (ALLOWED_TYPES.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error(`不支持的文件类型: ${file.mimetype}`));
  }
};

const upload = multer({ storage, fileFilter, limits: { fileSize: MAX_SIZE } });

const router = Router();

/**
 * @swagger
 * tags:
 *   name: Images
 *   description: 图片管理接口
 */

function getImageTags(imageId) {
  return db.prepare(`
    SELECT t.id, t.name, t.slug FROM tags t
    JOIN image_tags it ON t.id = it.tag_id
    WHERE it.image_id = ?
  `).all(imageId);
}

async function extractExif(filePath, mimeType) {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(mimeType)) return {};
  try {
    const data = await exifr.parse(filePath, {
      pick: ['Make', 'Model', 'FocalLength', 'FNumber', 'ExposureTime',
        'ISO', 'DateTimeOriginal', 'Flash', 'GPSLatitude', 'GPSLongitude',
        'ImageWidth', 'ImageHeight', 'LensModel', 'ExposureCompensation',
        'Software', 'Orientation', 'ApertureValue', 'ShutterSpeedValue',
        'WhiteBalance', 'MeteringMode', 'Copyright'],
    });
    if (!data) return {};
    const exif = {};
    if (data.Make) exif.make = data.Make;
    if (data.Model) exif.model = data.Model;
    if (data.LensModel) exif.lens = data.LensModel;
    if (data.FocalLength) exif.focalLength = typeof data.FocalLength === 'number' ? `${data.FocalLength}mm` : data.FocalLength;
    if (data.FNumber) exif.aperture = `f/${typeof data.FNumber === 'number' ? data.FNumber.toFixed(1) : data.FNumber}`;
    if (data.ExposureTime) {
      const et = data.ExposureTime;
      exif.shutterSpeed = typeof et === 'number' && et < 1 ? `1/${Math.round(1 / et)}s` : `${et}s`;
    }
    if (data.ISO) exif.iso = `ISO ${data.ISO}`;
    if (data.DateTimeOriginal) exif.dateTaken = data.DateTimeOriginal instanceof Date
      ? data.DateTimeOriginal.toISOString()
      : String(data.DateTimeOriginal);
    if (data.Flash !== undefined) {
      const flashVal = typeof data.Flash === 'string'
        ? data.Flash.toLowerCase().includes('fire') || data.Flash.toLowerCase().includes('on')
        : !!data.Flash;
      exif.flash = flashVal ? '闪光灯开启' : '未开启';
    }
    if (data.ExposureCompensation !== undefined) {
      const ec = data.ExposureCompensation;
      exif.exposureCompensation = typeof ec === 'number' ? (ec >= 0 ? `+${ec.toFixed(1)} EV` : `${ec.toFixed(1)} EV`) : ec;
    }
    if (data.GPSLatitude != null && data.GPSLongitude != null) {
      exif.gps = `${Number(data.GPSLatitude).toFixed(5)}, ${Number(data.GPSLongitude).toFixed(5)}`;
    }
    if (data.ImageWidth && data.ImageHeight) {
      exif.dimensions = `${data.ImageWidth} × ${data.ImageHeight}`;
    }
    if (data.Software) exif.software = data.Software;
    if (data.Copyright) exif.copyright = data.Copyright;
    return exif;
  } catch (err) {
    console.error('exifr解析失败:', filePath, err.message);
    return {};
  }
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

function syncTags(imageId, tags) {
  db.prepare('DELETE FROM image_tags WHERE image_id = ?').run(imageId);
  if (!Array.isArray(tags)) return;
  for (const name of tags) {
    const tagName = (name || '').trim();
    if (!tagName) continue;
    db.prepare('INSERT OR IGNORE INTO tags (name) VALUES (?)').run(tagName);
    const tag = db.prepare('SELECT id FROM tags WHERE name = ?').get(tagName);
    if (tag) db.prepare('INSERT OR IGNORE INTO image_tags (image_id, tag_id) VALUES (?, ?)').run(imageId, tag.id);
  }
}

/**
 * @swagger
 * /api/images/upload:
 *   post:
 *     tags: [Images]
 *     summary: 上传单张图片
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               file: { type: string, format: binary }
 *               title: { type: string }
 *               tags: { type: string, description: "JSON array of tag names" }
 *               category_id: { type: integer }
 *     responses:
 *       201: { description: 上传成功 }
 *       400: { description: 上传失败 }
 *       401: { description: 未登录 }
 */
router.post('/upload', requireAuth, (req, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE'
        ? `文件大小超过限制（最大${appConfig.maxFileSizeMB}MB）`
        : (err.message || '上传失败');
      return res.status(400).json({ error: msg });
    }
    if (!req.file) {
      return res.status(400).json({ error: '请选择要上传的文件' });
    }

    const { title, description } = req.body;
    let tags = [];
    try { tags = JSON.parse(req.body.tags || '[]'); } catch { /* ignore */ }
    const categoryId = parseInt(req.body.category_id) || null;

    const filePath = join(uploadsDir, req.file.filename);

    const result = db.prepare(
      'INSERT INTO images (user_id, uuid, filename, original_name, mime_type, file_size, title, description, category_id, exif) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      req.user.user_id,
      basename(req.file.filename, extname(req.file.filename)),
      req.file.filename,
      req.file.originalname,
      req.file.mimetype,
      req.file.size,
      title || basename(req.file.originalname, extname(req.file.originalname)),
      description || '',
      categoryId,
      '{}'
    );

    syncTags(result.lastInsertRowid, tags);

    try {
      const exif = await extractExif(filePath, req.file.mimetype);
      db.prepare('UPDATE images SET exif = ? WHERE id = ?').run(JSON.stringify(exif), result.lastInsertRowid);
    } catch (exifErr) {
      console.error('EXIF提取失败:', exifErr.message);
    }

    res.status(201).json({
      message: '上传成功',
      image: {
        id: result.lastInsertRowid,
        uuid: basename(req.file.filename, extname(req.file.filename)),
        title: title || req.file.originalname,
        filename: req.file.filename,
      },
    });
  });
});

/**
 * @swagger
 * /api/images/batch-info:
 *   get:
 *     tags: [Images]
 *     summary: 获取批量编辑的预填信息
 *     parameters:
 *       - in: query
 *         name: ids
 *         required: true
 *         schema: { type: string }
 *         description: "逗号分隔的图片ID列表"
 *     responses:
 *       200:
 *         description: 公共分类和标签交集/并集
 *       403: { description: 无权限 }
 */
router.get('/batch-info', requireAuth, (req, res) => {
  const raw = (req.query.ids || '').trim();
  if (!raw) return res.status(400).json({ error: '请提供图片ID列表' });

  const ids = raw.split(',').map((s) => parseInt(s.trim())).filter((n) => n > 0);
  if (ids.length === 0) return res.status(400).json({ error: '无效的图片ID列表' });

  const placeholders = ids.map(() => '?').join(',');
  const images = db.prepare(`SELECT id, user_id, category_id FROM images WHERE id IN (${placeholders})`).all(...ids);

  const isAdmin = req.user.role === 'admin';
  const forbidden = images.filter((img) => !isAdmin && img.user_id !== req.user.user_id);
  if (forbidden.length > 0) {
    return res.status(403).json({ error: `无权限查看 ${forbidden.length} 张图片` });
  }

  const validIds = images.map((img) => img.id);

  const categoryIds = [...new Set(images.map((img) => img.category_id))];
  const commonCategoryId = categoryIds.length === 1 ? categoryIds[0] : null;

  const allTags = [];
  for (const id of validIds) {
    allTags.push(...getImageTags(id));
  }
  const tagMap = {};
  for (const t of allTags) {
    if (!tagMap[t.id]) tagMap[t.id] = { ...t, count: 0 };
    tagMap[t.id].count++;
  }

  const allTagsList = Object.values(tagMap).map((t) => ({ id: t.id, name: t.name, count: t.count }));
  const commonTags = allTagsList.filter((t) => t.count === validIds.length).map((t) => ({ id: t.id, name: t.name }));

  const categories = db.prepare('SELECT id, name, slug FROM categories ORDER BY id ASC').all();

  res.json({
    count: validIds.length,
    common_category_id: commonCategoryId,
    common_tags: commonTags,
    all_tags: allTagsList,
    categories,
  });
});

router.post('/batch-upload', requireAuth, (req, res) => {
  upload.array('files', MAX_BATCH)(req, res, async (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE'
        ? `文件大小超过限制（最大${appConfig.maxFileSizeMB}MB）`
        : (err.message || '上传失败');
      return res.status(400).json({ error: msg });
    }
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: '请选择要上传的文件' });
    }

    const results = [];
    const categoryId = parseInt(req.body.category_id) || null;
    for (const file of req.files) {
      const filePath = join(uploadsDir, file.filename);
      const result = db.prepare(
        'INSERT INTO images (user_id, uuid, filename, original_name, mime_type, file_size, title, category_id, exif) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(
        req.user.user_id,
        basename(file.filename, extname(file.filename)),
        file.filename,
        file.originalname,
        file.mimetype,
        file.size,
        basename(file.originalname, extname(file.originalname)),
        categoryId,
        '{}'
      );
      try {
        const exif = await extractExif(filePath, file.mimetype);
        db.prepare('UPDATE images SET exif = ? WHERE id = ?').run(JSON.stringify(exif), result.lastInsertRowid);
      } catch (exifErr) {
        console.error('EXIF提取失败:', exifErr.message);
      }
      results.push({
        id: result.lastInsertRowid,
        uuid: basename(file.filename, extname(file.filename)),
        original_name: file.originalname,
        filename: file.filename,
      });
    }

    res.status(201).json({
      message: `成功上传 ${req.files.length} 个文件中的 ${results.length} 个`,
      uploaded: results,
      errors: [],
    });
  });
});

/**
 * @swagger
 * /api/images/list:
 *   get:
 *     tags: [Images]
 *     summary: 图片列表（公开）
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20 }
 *       - in: query
 *         name: tag
 *         schema: { type: string }
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *       - in: query
 *         name: my
 *         schema: { type: string }
 *         description: "1=仅看自己的"
 *       - in: query
 *         name: category_id
 *         schema: { type: integer }
 *     responses:
 *       200: { description: 图片列表 }
 */
router.get('/list', (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
  const offset = (page - 1) * limit;
  const tag = (req.query.tag || '').trim();
  const search = (req.query.search || '').trim();
  const myOnly = req.query.my === '1';
  const filterUserId = parseInt(req.query.user_id) || 0;
  const categoryId = parseInt(req.query.category_id) || 0;

  const conditions = [];
  const params = [];

  if (myOnly && req.user) {
    conditions.push('i.user_id = ?');
    params.push(req.user.user_id);
  } else if (filterUserId) {
    conditions.push('i.user_id = ?');
    params.push(filterUserId);
  }

  if (categoryId) {
    conditions.push('i.category_id = ?');
    params.push(categoryId);
  }

  if (search) {
    conditions.push('(i.title LIKE ? OR i.original_name LIKE ?)');
    params.push(`%${search}%`, `%${search}%`);
  }

  if (tag) {
    conditions.push(`EXISTS (SELECT 1 FROM image_tags it2 JOIN tags t2 ON it2.tag_id = t2.id WHERE it2.image_id = i.id AND t2.name LIKE ?)`);
    params.push(`%${tag}%`);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const countRow = db.prepare(`SELECT COUNT(*) as total FROM images i ${whereClause}`).get(...params);
  const total = countRow ? countRow.total : 0;

  const rows = db.prepare(`
    SELECT i.*, u.username as uploader_name
    FROM images i
    JOIN users u ON i.user_id = u.id
    ${whereClause}
    ORDER BY i.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  const images = rows.map(formatImage);

  res.json({
    images,
    pagination: {
      page,
      limit,
      total,
      total_pages: Math.ceil(total / limit),
    },
  });
});

/**
 * @swagger
 * /api/images/detail/{id}:
 *   get:
 *     tags: [Images]
 *     summary: 图片详情
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: 图片详情 }
 *       404: { description: 图片不存在 }
 */
router.get('/detail/:id', (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: '无效的图片ID' });

  const row = db.prepare(`
    SELECT i.*, u.username as uploader_name
    FROM images i JOIN users u ON i.user_id = u.id
    WHERE i.id = ?
  `).get(id);

  if (!row) return res.status(404).json({ error: '图片不存在' });

  res.json(formatImage(row));
});

router.get('/by-uuid/:uuid', (req, res) => {
  const uuid = (req.params.uuid || '').trim();
  if (!uuid) return res.status(400).json({ error: '无效的UUID' });

  const row = db.prepare(`
    SELECT i.*, u.username as uploader_name
    FROM images i JOIN users u ON i.user_id = u.id
    WHERE i.uuid = ?
  `).get(uuid);

  if (!row) return res.status(404).json({ error: '图片不存在或链接已失效' });

  res.json(formatImage(row));
});

router.post('/sign-url', (req, res) => {
  const { filename, w, q, m, dl } = req.body || {};
  if (!filename) return res.status(400).json({ error: '缺少 filename 参数' });

  const row = db.prepare('SELECT filename FROM images WHERE filename = ?').get(filename);
  if (!row) return res.status(404).json({ error: '图片不存在' });

  const params = {};
  const readable = [];

  if (w !== undefined && w !== null && w !== '') {
    params.w = String(w);
    readable.push(`宽=${w}px`);
  }
  if (q !== undefined && q !== null && q !== '') {
    params.q = String(q);
    readable.push(`质量=${q}`);
  }
  if (m) {
    params.m = String(m);
    readable.push(`水印=${m}`);
  }
  if (dl === '1' || dl === 1) {
    params.dl = '1';
    readable.push('下载模式');
  }

  const base = `/api/img/${filename}`;
  const url = generateSignedUrl(filename, base, params);

  res.json({
    filename,
    params,
    label: readable.length > 0 ? readable.join(', ') : '原图',
    url,
  });
});

router.put('/detail/:id', requireAuth, (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: '无效的图片ID' });

  const image = db.prepare('SELECT user_id FROM images WHERE id = ?').get(id);
  if (!image) return res.status(404).json({ error: '图片不存在' });
  if (req.user.role !== 'admin' && image.user_id !== req.user.user_id) {
    return res.status(403).json({ error: '无权限修改此图片' });
  }

  const { title, description, tags, category_id } = req.body;

  if (title !== undefined || description !== undefined || category_id !== undefined) {
    const updates = [];
    const params = [];
    if (title !== undefined) { updates.push('title = ?'); params.push(title); }
    if (description !== undefined) { updates.push('description = ?'); params.push(description); }
    if (category_id !== undefined) { updates.push('category_id = ?'); params.push(parseInt(category_id) || null); }
    if (updates.length > 0) {
      params.push(id);
      db.prepare(`UPDATE images SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    }
  }

  if (tags !== undefined) {
    syncTags(id, tags);
  }

  res.json({ message: '更新成功' });
});

router.delete('/delete/:id', requireAuth, (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: '无效的图片ID' });

  const image = db.prepare('SELECT user_id, filename FROM images WHERE id = ?').get(id);
  if (!image) return res.status(404).json({ error: '图片不存在' });
  if (req.user.role !== 'admin' && image.user_id !== req.user.user_id) {
    return res.status(403).json({ error: '无权限删除此图片' });
  }

  const filePath = join(uploadsDir, image.filename);
  if (existsSync(filePath)) {
    unlinkSync(filePath);
  }

  db.prepare('DELETE FROM images WHERE id = ?').run(id);
  res.json({ message: '删除成功' });
});

/**
 * @swagger
 * /api/images/batch-delete:
 *   post:
 *     tags: [Images]
 *     summary: 批量删除图片
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [ids]
 *             properties:
 *               ids: { type: array, items: { type: integer } }
 *     responses:
 *       200: { description: 删除结果 }
 *       403: { description: 无权限 }
 */
router.post('/batch-delete', requireAuth, (req, res) => {
  const { ids } = req.body || {};
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: '请提供要删除的图片ID列表' });
  }

  const placeholders = ids.map(() => '?').join(',');
  const images = db.prepare(`SELECT id, user_id, filename FROM images WHERE id IN (${placeholders})`).all(...ids);

  const isAdmin = req.user.role === 'admin';
  const forbidden = images.filter((img) => !isAdmin && img.user_id !== req.user.user_id);
  if (forbidden.length > 0) {
    return res.status(403).json({ error: `无权限删除 ${forbidden.length} 张图片` });
  }

  for (const img of images) {
    const filePath = join(uploadsDir, img.filename);
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }
  }

  db.prepare(`DELETE FROM images WHERE id IN (${placeholders})`).run(...ids);
  const failed = ids.length - images.length;
  res.json({
    message: `成功删除 ${images.length} 张图片` + (failed > 0 ? `，${failed} 张不存在` : ''),
    deleted: images.length,
    failed,
  });
});

/**
 * @swagger
 * /api/images/batch-update:
 *   post:
 *     tags: [Images]
 *     summary: 批量更新图片（分类/标签）
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [ids]
 *             properties:
 *               ids: { type: array, items: { type: integer } }
 *               category_id: { type: integer, nullable: true }
 *               tags: { type: array, items: { type: string }, description: "覆盖标签" }
 *               add_tags: { type: array, items: { type: string }, description: "追加标签" }
 *               remove_tags: { type: array, items: { type: string }, description: "移除标签" }
 *     responses:
 *       200: { description: 更新结果 }
 *       403: { description: 无权限 }
 */
router.post('/batch-update', requireAuth, (req, res) => {
  const { ids, category_id, tags, add_tags, remove_tags } = req.body || {};
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: '请提供要更新的图片ID列表' });
  }

  const placeholders = ids.map(() => '?').join(',');
  const images = db.prepare(`SELECT id, user_id FROM images WHERE id IN (${placeholders})`).all(...ids);

  const isAdmin = req.user.role === 'admin';
  const forbidden = images.filter((img) => !isAdmin && img.user_id !== req.user.user_id);
  if (forbidden.length > 0) {
    return res.status(403).json({ error: `无权限修改 ${forbidden.length} 张图片` });
  }

  const validIds = images.map((img) => img.id);

  if (category_id !== undefined) {
    const catId = parseInt(category_id) || null;
    const catPlaceholders = validIds.map(() => '?').join(',');
    db.prepare(`UPDATE images SET category_id = ? WHERE id IN (${catPlaceholders})`).run(catId, ...validIds);
  }

  if (tags !== undefined && Array.isArray(tags)) {
    for (const id of validIds) {
      syncTags(id, tags);
    }
  }

  if (add_tags !== undefined && Array.isArray(add_tags)) {
    for (const id of validIds) {
      const existing = getImageTags(id).map((t) => t.name);
      const merged = [...new Set([...existing, ...add_tags])];
      syncTags(id, merged);
    }
  }

  if (remove_tags !== undefined && Array.isArray(remove_tags)) {
    for (const id of validIds) {
      const existing = getImageTags(id).map((t) => t.name);
      const filtered = existing.filter((t) => !remove_tags.includes(t));
      syncTags(id, filtered);
    }
  }

  const failed = ids.length - validIds.length;
  res.json({
    message: `成功更新 ${validIds.length} 张图片` + (failed > 0 ? `，${failed} 张不存在` : ''),
    updated: validIds.length,
    failed,
  });
});

export default router;
