import { Router } from 'express';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import { extname, basename } from 'path';
import { existsSync, unlinkSync, createReadStream } from 'fs';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import exifr from 'exifr';
import db from '../config/database.js';
import appConfig from '../config/app.js';
import { requireAuth } from '../middleware/auth.js';
import { generateSignedUrl } from '../utils/signing.js';
import { logImageUpload, logImageDelete, logImageEdit, logBatchImageDelete, logBatchImageUpdate } from '../utils/logger.js';

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
  const rows = db.prepare(`
    SELECT t.id FROM tags t
    JOIN image_tags it ON t.id = it.tag_id
    WHERE it.image_id = ?
  `).all(imageId);
  return rows.map(r => r.id);
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

function computeFileHash(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

function checkDuplicate(hash) {
  return db.prepare(
    'SELECT id FROM images WHERE file_hash = ? AND is_duplicate = 0 LIMIT 1'
  ).get(hash);
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
    is_duplicate: row.is_duplicate || 0,
    duplicate_of: row.duplicate_of || null,
  };
}

function syncTags(imageId, tagIds) {
  db.prepare('DELETE FROM image_tags WHERE image_id = ?').run(imageId);
  if (!Array.isArray(tagIds)) return;
  const insert = db.prepare('INSERT OR IGNORE INTO image_tags (image_id, tag_id) VALUES (?, ?)');
  for (const tid of tagIds) {
    const id = parseInt(tid);
    if (!id) continue;
    insert.run(imageId, id);
  }
}

/**
 * @swagger
 * /api/images/upload:
 *   post:
 *     tags: [Images]
 *     summary: 上传单张图片
 *     description: 上传单张图片文件，支持设置标题、描述、标签和分类
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [file]
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *                 description: 图片文件
 *               title:
 *                 type: string
 *                 description: 图片标题
 *               description:
 *                 type: string
 *                 description: 图片描述
 *               tags:
 *                 type: array
 *                 items: { type: integer }
 *                 description: 标签ID数组，如 [1, 2, 3]
 *               category_id:
 *                 type: integer
 *                 description: 分类ID
 *     responses:
 *       201:
 *         description: 上传成功
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message: { type: string }
 *                 is_duplicate: { type: boolean }
 *                 duplicate_of: { type: integer, nullable: true }
 *                 image:
 *                   type: object
 *                   properties:
 *                     id: { type: integer }
 *                     uuid: { type: string }
 *                     title: { type: string }
 *                     filename: { type: string }
 *       400:
 *         description: 上传失败
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

    const { title, description, category_id } = req.body;
    let tags = [];
    try { tags = JSON.parse(req.body.tags || '[]').map(t => parseInt(t)).filter(n => n > 0); } catch { /* ignore */ }
    const categoryId = parseInt(category_id) || 1;

    const filePath = join(uploadsDir, req.file.filename);

    let fileHash = '';
    let originalId = null;
    let isDup = 0;
    try {
      fileHash = await computeFileHash(filePath);
      const existing = checkDuplicate(fileHash);
      if (existing) {
        originalId = existing.id;
        isDup = 1;
      }
    } catch (hashErr) {
      console.error('哈希计算失败:', hashErr.message);
    }

    const result = db.prepare(
      'INSERT INTO images (user_id, uuid, filename, original_name, mime_type, file_size, title, description, category_id, exif, file_hash, is_duplicate, duplicate_of) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
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
      '{}',
      fileHash,
      isDup,
      originalId,
    );

    syncTags(result.lastInsertRowid, tags);

    try {
      const exif = await extractExif(filePath, req.file.mimetype);
      db.prepare('UPDATE images SET exif = ? WHERE id = ?').run(JSON.stringify(exif), result.lastInsertRowid);
    } catch (exifErr) {
      console.error('EXIF提取失败:', exifErr.message);
    }

    res.status(201).json({
      message: isDup ? '检测到重复文件，已标记' : '上传成功',
      is_duplicate: !!isDup,
      duplicate_of: originalId,
      image: {
        id: result.lastInsertRowid,
        uuid: basename(req.file.filename, extname(req.file.filename)),
        title: title || req.file.originalname,
        filename: req.file.filename,
      },
    });

    logImageUpload(req, {
      id: result.lastInsertRowid,
      uuid: basename(req.file.filename, extname(req.file.filename)),
      original_name: req.file.originalname,
      file_size: req.file.size,
      mime_type: req.file.mimetype,
      title: title || basename(req.file.originalname, extname(req.file.originalname)),
      is_duplicate: !!isDup,
      duplicate_of: originalId,
    });
  });
});

/**
 * @swagger
 * /api/images/batch-info:
 *   get:
 *     tags: [Images]
 *     summary: 获取批量编辑的预填信息
 *     description: 根据图片ID列表获取公共分类、标签交集/并集等信息，用于批量编辑预处理
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: ids
 *         required: true
 *         schema: { type: string }
 *         description: 逗号分隔的图片ID列表，如 "1,2,3"
 *     responses:
 *       200:
 *         description: 公共分类和标签交集/并集
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 count: { type: integer, description: '有效图片数量' }
 *                 common_category_id: { type: integer, nullable: true, description: '公共分类ID（仅当全部图片同一分类时）' }
 *                 common_tags:
 *                   type: array
 *                   items: { type: integer }
 *                   description: 公共标签ID交集
 *                 all_tags:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: integer }
 *                       count: { type: integer }
 *                 categories:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/Category' }
 *       400:
 *         description: 参数错误
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiError'
 *       403:
 *         description: 无权限
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiError'
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
  const tagCountMap = {};
  for (const tid of allTags) {
    tagCountMap[tid] = (tagCountMap[tid] || 0) + 1;
  }

  const allTagsList = Object.entries(tagCountMap).map(([id, count]) => ({ id: parseInt(id), count }));
  const commonTags = allTagsList.filter((t) => t.count === validIds.length).map((t) => t.id);

  const categories = db.prepare('SELECT id, name, description FROM categories ORDER BY id ASC').all();

  res.json({
    count: validIds.length,
    common_category_id: commonCategoryId,
    common_tags: commonTags,
    all_tags: allTagsList,
    categories,
  });
});

/**
 * @swagger
 * /api/images/batch-upload:
 *   post:
 *     tags: [Images]
 *     summary: 批量上传图片
 *     description: 一次性上传多张图片（最大批量数量由系统配置决定）
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [files]
 *             properties:
 *               files:
 *                 type: array
 *                 items: { type: string, format: binary }
 *                 description: 图片文件列表
 *               category_id:
 *                 type: integer
 *                 description: 分类ID
 *     responses:
 *       201:
 *         description: 上传完成
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message: { type: string }
 *                 duplicate_count: { type: integer }
 *                 uploaded:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: integer }
 *                       uuid: { type: string }
 *                       original_name: { type: string }
 *                       filename: { type: string }
 *                       is_duplicate: { type: boolean }
 *                       duplicate_of: { type: integer, nullable: true }
 *                 errors: { type: array, items: { type: string } }
 *       400:
 *         description: 上传失败
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
 */
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
    let dupCount = 0;
    const categoryId = parseInt(req.body.category_id) || 1;
    for (const file of req.files) {
      const filePath = join(uploadsDir, file.filename);

      let fileHash = '';
      let originalId = null;
      let isDup = 0;
      try {
        fileHash = await computeFileHash(filePath);
        const existing = checkDuplicate(fileHash);
        if (existing) {
          originalId = existing.id;
          isDup = 1;
          dupCount++;
        }
      } catch (hashErr) {
        console.error('哈希计算失败:', hashErr.message);
      }

      const result = db.prepare(
        'INSERT INTO images (user_id, uuid, filename, original_name, mime_type, file_size, title, category_id, exif, file_hash, is_duplicate, duplicate_of) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(
        req.user.user_id,
        basename(file.filename, extname(file.filename)),
        file.filename,
        file.originalname,
        file.mimetype,
        file.size,
        basename(file.originalname, extname(file.originalname)),
        categoryId,
        '{}',
        fileHash,
        isDup,
        originalId,
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
        is_duplicate: !!isDup,
        duplicate_of: originalId,
      });

      logImageUpload(req, {
        id: result.lastInsertRowid,
        uuid: basename(file.filename, extname(file.filename)),
        original_name: file.originalname,
        file_size: file.size,
        mime_type: file.mimetype,
        title: basename(file.originalname, extname(file.originalname)),
        is_duplicate: !!isDup,
        duplicate_of: originalId,
      });
    }

    res.status(201).json({
      message: `成功上传 ${req.files.length} 个文件${dupCount > 0 ? `（其中 ${dupCount} 个为重复）` : ''}`,
      duplicate_count: dupCount,
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
 *     description: 分页获取图片列表，支持搜索、标签筛选、分类筛选、排序和只看自己的图片
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *         description: 页码
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20 }
 *         description: 每页数量（最大50）
 *       - in: query
 *         name: tag
 *         schema: { type: string }
 *         description: 按标签筛选（已废弃，请使用 tags）
 *       - in: query
 *         name: tags
 *         schema: { type: string }
 *         description: 多标签ID筛选，逗号分隔，如 "1,2,3"
 *       - in: query
 *         name: tag_match
 *         schema: { type: string, enum: [any, all], default: any }
 *         description: 标签匹配模式，any=任一匹配，all=全部匹配
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *         description: 搜索关键词（匹配标题和原始文件名）
 *       - in: query
 *         name: my
 *         schema: { type: string }
 *         description: 设为 1 仅查看自己上传的图片
 *       - in: query
 *         name: user_uuid
 *         schema: { type: string }
 *         description: 按上传者用户UUID筛选
 *       - in: query
 *         name: category_id
 *         schema: { type: integer }
 *         description: 按分类ID筛选
 *       - in: query
 *         name: sort
 *         schema: { type: string, enum: [relevance, upload_time, created_time, name, filesize], default: upload_time }
 *         description: 排序字段
 *       - in: query
 *         name: sort_order
 *         schema: { type: string, enum: [asc, desc], default: desc }
 *         description: 排序方向
 *     responses:
 *       200:
 *         description: 图片列表
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 images:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Image'
 *                 pagination:
 *                   $ref: '#/components/schemas/Pagination'
 */
router.get('/list', (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
  const offset = (page - 1) * limit;
  const search = (req.query.search || '').trim();
  const myOnly = req.query.my === '1';
  const filterUserUuid = (req.query.user_uuid || '').trim();
  const categoryId = parseInt(req.query.category_id) || 0;

  // 多标签筛选（按ID）
  const tagsRaw = (req.query.tags || '').split(',').map((t) => parseInt(t.trim())).filter(n => n > 0);
  const tagMatch = req.query.tag_match === 'all' ? 'all' : 'any';

  // 排序
  const sort = req.query.sort || 'upload_time';
  const sortOrder = req.query.sort_order === 'asc' ? 'ASC' : 'DESC';

  const conditions = [];
  const params = [];

  if (myOnly && req.user) {
    conditions.push('u.uuid = ?');
    params.push(req.user.uuid);
  } else if (filterUserUuid) {
    conditions.push('u.uuid = ?');
    params.push(filterUserUuid);
  }

  if (categoryId) {
    conditions.push('i.category_id = ?');
    params.push(categoryId);
  }

  if (search) {
    conditions.push('(i.title LIKE ? OR i.original_name LIKE ?)');
    params.push(`%${search}%`, `%${search}%`);
  }

  let relevanceExpr = '0';
  let relevanceParams = [];
  if (tagsRaw.length > 0) {
    const placeholders = tagsRaw.map(() => '?').join(',');
    if (tagMatch === 'all') {
      conditions.push(`(SELECT COUNT(DISTINCT it2.tag_id) FROM image_tags it2 WHERE it2.image_id = i.id AND it2.tag_id IN (${placeholders})) = ?`);
      params.push(...tagsRaw, tagsRaw.length);
    } else {
      conditions.push(`EXISTS (SELECT 1 FROM image_tags it2 WHERE it2.image_id = i.id AND it2.tag_id IN (${placeholders}))`);
      params.push(...tagsRaw);
    }
    relevanceExpr = `(SELECT COUNT(DISTINCT it2.tag_id) FROM image_tags it2 WHERE it2.image_id = i.id AND it2.tag_id IN (${placeholders}))`;
    relevanceParams = [...tagsRaw];
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const countRow = db.prepare(`SELECT COUNT(*) as total FROM images i JOIN users u ON i.user_id = u.id ${whereClause}`).get(...params);
  const total = countRow ? countRow.total : 0;

  const SORT_MAP = {
    relevance: `relevance ${sortOrder}, i.created_at ${sortOrder}`,
    upload_time: `i.created_at ${sortOrder}`,
    created_time: `COALESCE(json_extract(i.exif, '$.dateTaken'), i.created_at) ${sortOrder}`,
    name: `COALESCE(NULLIF(i.title, ''), i.original_name) ${sortOrder}`,
    filesize: `i.file_size ${sortOrder}`,
  };
  const orderClause = SORT_MAP[sort] || SORT_MAP.upload_time;

  const selectFields = `i.*, u.uuid as uploader_uuid, ${relevanceExpr} AS relevance`;

  const rows = db.prepare(`
    SELECT ${selectFields}
    FROM images i
    JOIN users u ON i.user_id = u.id
    ${whereClause}
    ORDER BY ${orderClause}
    LIMIT ? OFFSET ?
  `).all(...relevanceParams, ...params, limit, offset);

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
 *     description: 根据图片ID获取图片详细信息，包括标签、EXIF和缩略图URL
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *         description: 图片ID
 *     responses:
 *       200:
 *         description: 图片详情
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Image'
 *       400:
 *         description: 无效的图片ID
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiError'
 *       404:
 *         description: 图片不存在
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiError'
 */
router.get('/detail/:id', (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: '无效的图片ID' });

  const row = db.prepare(`
    SELECT i.*, u.uuid as uploader_uuid
    FROM images i JOIN users u ON i.user_id = u.id
    WHERE i.id = ?
  `).get(id);

  if (!row) return res.status(404).json({ error: '图片不存在' });

  res.json(formatImage(row));
});

/**
 * @swagger
 * /api/images/by-uuid/{uuid}:
 *   get:
 *     tags: [Images]
 *     summary: 通过UUID获取图片
 *     description: 根据图片UUID获取图片详细信息
 *     parameters:
 *       - in: path
 *         name: uuid
 *         required: true
 *         schema: { type: string }
 *         description: 图片UUID
 *     responses:
 *       200:
 *         description: 图片详情
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Image'
 *       400:
 *         description: 无效的UUID
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiError'
 *       404:
 *         description: 图片不存在或链接已失效
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiError'
 */
router.get('/by-uuid/:uuid', (req, res) => {
  const uuid = (req.params.uuid || '').trim();
  if (!uuid) return res.status(400).json({ error: '无效的UUID' });

  const row = db.prepare(`
    SELECT i.*, u.uuid as uploader_uuid
    FROM images i JOIN users u ON i.user_id = u.id
    WHERE i.uuid = ?
  `).get(uuid);

  if (!row) return res.status(404).json({ error: '图片不存在或链接已失效' });

  res.json(formatImage(row));
});

/**
 * @swagger
 * /api/images/sign-url:
 *   post:
 *     tags: [Images]
 *     summary: 生成签名URL
 *     description: 为指定图片生成带签名的访问URL，支持设置宽度、质量、水印和下载模式
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [filename]
 *             properties:
 *               filename:
 *                 type: string
 *                 description: 图片文件名
 *               w:
 *                 type: integer
 *                 description: 宽度（像素）
 *               q:
 *                 type: integer
 *                 description: 质量（1-100）
 *               m:
 *                 type: string
 *                 description: 水印模式
 *               dl:
 *                 type: string
 *                 description: 设为 1 表示下载模式
 *     responses:
 *       200:
 *         description: 签名URL
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 filename: { type: string }
 *                 params:
 *                   type: object
 *                   description: 实际使用的参数
 *                 label: { type: string, description: '参数的可读描述' }
 *                 url: { type: string, description: '带签名的完整URL' }
 *       400:
 *         description: 缺少参数
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiError'
 *       404:
 *         description: 图片不存在
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiError'
 */
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

/**
 * @swagger
 * /api/images/detail/{id}:
 *   put:
 *     tags: [Images]
 *     summary: 更新图片详情
 *     description: 更新图片的标题、描述、标签和分类（仅限上传者本人或管理员）
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *         description: 图片ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               title:
 *                 type: string
 *                 description: 图片标题
 *               description:
 *                 type: string
 *                 description: 图片描述
 *               tags:
 *                 type: array
 *                 items: { type: integer }
 *                 description: 标签ID列表（覆盖模式）
 *               category_id:
 *                 type: integer
 *                 nullable: true
 *                 description: 分类ID
 *     responses:
 *       200:
 *         description: 更新成功
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiMessage'
 *       400:
 *         description: 无效的图片ID
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiError'
 *       403:
 *         description: 无权限
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiError'
 *       404:
 *         description: 图片不存在
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiError'
 */
router.put('/detail/:id', requireAuth, (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: '无效的图片ID' });

  const image = db.prepare('SELECT user_id, uuid, title, description, category_id FROM images WHERE id = ?').get(id);
  if (!image) return res.status(404).json({ error: '图片不存在' });
  if (req.user.role !== 'admin' && image.user_id !== req.user.user_id) {
    return res.status(403).json({ error: '无权限修改此图片' });
  }

  const { title, description, tags, category_id } = req.body;

  const before = { title: image.title || '', description: image.description || '', category_id: image.category_id || null };
  if (tags !== undefined) {
    before.tags = getImageTags(id).map(t => t.name);
  }

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

  const after = { title: title !== undefined ? title : before.title, description: description !== undefined ? description : before.description, category_id: category_id !== undefined ? (parseInt(category_id) || null) : before.category_id };
  if (tags !== undefined) {
    after.tags = (Array.isArray(tags) ? tags : []).filter(t => typeof t === 'string' ? t.trim() : t);
  } else {
    after.tags = before.tags;
  }

  res.json({ message: '更新成功' });

  logImageEdit(req, id, image.uuid, before, after);
});

/**
 * @swagger
 * /api/images/delete/{id}:
 *   delete:
 *     tags: [Images]
 *     summary: 删除单张图片
 *     description: 删除指定图片及其文件（仅限上传者本人或管理员）
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *         description: 图片ID
 *     responses:
 *       200:
 *         description: 删除成功
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiMessage'
 *       400:
 *         description: 无效的图片ID
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiError'
 *       403:
 *         description: 无权限
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiError'
 *       404:
 *         description: 图片不存在
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiError'
 */
router.delete('/delete/:id', requireAuth, (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: '无效的图片ID' });

  const image = db.prepare('SELECT user_id, uuid, filename, original_name, file_size, title FROM images WHERE id = ?').get(id);
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

  logImageDelete(req, image);
});

/**
 * @swagger
 * /api/images/batch-delete:
 *   post:
 *     tags: [Images]
 *     summary: 批量删除图片
 *     description: 批量删除多张图片及文件（管理员可删除任意图片，普通用户仅限自己的图片）
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [ids]
 *             properties:
 *               ids:
 *                 type: array
 *                 items: { type: integer }
 *                 description: 图片ID列表
 *     responses:
 *       200:
 *         description: 删除结果
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message: { type: string }
 *                 deleted: { type: integer, description: '成功删除数量' }
 *                 failed: { type: integer, description: '失败数量' }
 *       400:
 *         description: 参数错误
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiError'
 *       403:
 *         description: 无权限
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiError'
 */
router.post('/batch-delete', requireAuth, (req, res) => {
  const { ids } = req.body || {};
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: '请提供要删除的图片ID列表' });
  }

  const placeholders = ids.map(() => '?').join(',');
  const images = db.prepare(`SELECT id, uuid, user_id, filename FROM images WHERE id IN (${placeholders})`).all(...ids);

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

  logBatchImageDelete(req, images.map(i => i.id), images.map(i => i.uuid));
});

/**
 * @swagger
 * /api/images/batch-update:
 *   post:
 *     tags: [Images]
 *     summary: 批量更新图片（分类/标签）
 *     description: 批量修改图片的分类和标签，支持覆盖、追加和移除标签操作
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [ids]
 *             properties:
 *               ids:
 *                 type: array
 *                 items: { type: integer }
 *                 description: 图片ID列表
 *               category_id:
 *                 type: integer
 *                 nullable: true
 *                 description: 分类ID（设置后覆盖所有图片的分类）
 *               tags:
 *                 type: array
 *                 items: { type: integer }
 *                 description: 覆盖标签ID列表（替换所有图片的标签）
 *               add_tags:
 *                 type: array
 *                 items: { type: integer }
 *                 description: 追加标签ID列表（在现有标签基础上添加）
 *               remove_tags:
 *                 type: array
 *                 items: { type: integer }
 *                 description: 移除标签ID列表（从现有标签中删除）
 *     responses:
 *       200:
 *         description: 更新结果
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message: { type: string }
 *                 updated: { type: integer, description: '成功更新数量' }
 *                 failed: { type: integer, description: '失败数量' }
 *       400:
 *         description: 参数错误
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiError'
 *       403:
 *         description: 无权限
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiError'
 */
router.post('/batch-update', requireAuth, (req, res) => {
  const { ids, category_id, tags, add_tags, remove_tags } = req.body || {};
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: '请提供要更新的图片ID列表' });
  }

  const placeholders = ids.map(() => '?').join(',');
  const images = db.prepare(`SELECT id, uuid, user_id FROM images WHERE id IN (${placeholders})`).all(...ids);

  const isAdmin = req.user.role === 'admin';
  const forbidden = images.filter((img) => !isAdmin && img.user_id !== req.user.user_id);
  if (forbidden.length > 0) {
    return res.status(403).json({ error: `无权限修改 ${forbidden.length} 张图片` });
  }

  const validIds = images.map((img) => img.id);
  const validUuids = images.map((img) => img.uuid);

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
      const existing = getImageTags(id);
      const merged = [...new Set([...existing, ...add_tags.map(t => parseInt(t)).filter(n => n > 0)])];
      syncTags(id, merged);
    }
  }

  if (remove_tags !== undefined && Array.isArray(remove_tags)) {
    const removeIds = remove_tags.map(t => parseInt(t)).filter(n => n > 0);
    for (const id of validIds) {
      const existing = getImageTags(id);
      const filtered = existing.filter((t) => !removeIds.includes(t));
      syncTags(id, filtered);
    }
  }

  const failed = ids.length - validIds.length;
  res.json({
    message: `成功更新 ${validIds.length} 张图片` + (failed > 0 ? `，${failed} 张不存在` : ''),
    updated: validIds.length,
    failed,
  });

  const changes = {};
  if (category_id !== undefined) changes.category_id = parseInt(category_id) || null;
  if (tags !== undefined) changes.tags = tags;
  if (add_tags !== undefined) changes.add_tags = add_tags;
  if (remove_tags !== undefined) changes.remove_tags = remove_tags;
  logBatchImageUpdate(req, validIds, validUuids, changes);
});

/**
 * @swagger
 * /api/images/duplicates:
 *   get:
 *     tags: [Images]
 *     summary: 获取重复图片列表
 *     description: 获取所有重复图片的分组信息，按文件哈希分组
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: 重复图片分组列表
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 total_duplicate_images:
 *                   type: integer
 *                   description: 被标记为重复的图片总数
 *                 total_groups:
 *                   type: integer
 *                   description: 重复分组数量
 *                 groups:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       hash: { type: string, description: '文件SHA256哈希值' }
 *                       count: { type: integer, description: '该组图片数量' }
 *                       images:
 *                         type: array
 *                         items: { $ref: '#/components/schemas/Image' }
 */
router.get('/duplicates', requireAuth, (req, res) => {
  const hashGroups = db.prepare(`
    SELECT file_hash, COUNT(*) as cnt
    FROM images
    WHERE file_hash != '' AND file_hash IS NOT NULL
    GROUP BY file_hash
    HAVING cnt >= 2
    ORDER BY cnt DESC
  `).all();

  const groups = hashGroups.map((g) => {
    const images = db.prepare(`
      SELECT i.*, u.uuid as uploader_uuid
      FROM images i
      JOIN users u ON i.user_id = u.id
      WHERE i.file_hash = ?
      ORDER BY i.is_duplicate ASC, i.created_at ASC
    `).all(g.file_hash);

    return {
      hash: g.file_hash,
      count: g.cnt,
      images: images.map(formatImage),
    };
  });

  const totalDuplicateImages = db.prepare('SELECT COUNT(*) as cnt FROM images WHERE is_duplicate = 1').get().cnt;
  const totalGroups = groups.length;

  res.json({
    total_duplicate_images: totalDuplicateImages,
    total_groups: totalGroups,
    groups,
  });
});

export default router;
