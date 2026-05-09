import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import db from '../config/database.js';
import appConfig from '../config/app.js';
import { requireAuth, isAdminRole } from '../middleware/auth.js';
import { generateSignedUrl } from '../utils/signing.js';
import { streamZipDownload } from '../utils/zip-stream.js';
import {
  logGalleryCreate,
  logGalleryUpdate,
  logGalleryDelete,
  logGalleryAddImages,
  logGalleryRemoveImages,
} from '../utils/logger.js';

const router = Router();

/**
 * @swagger
 * tags:
 *   name: Galleries
 *   description: 照片夹管理，支持创建、编辑、归档、协同、转移等
 */

function getUserUuid(req) {
  const row = db.prepare('SELECT uuid FROM users WHERE id = ?').get(req.user.user_id);
  return row ? row.uuid : null;
}

function isAdminUser(req) {
  return isAdminRole(req.user?.role);
}

function resolveImageId(target) {
  const byUuid = db.prepare('SELECT id FROM images WHERE uuid = ?').get(target);
  if (byUuid) return byUuid.id;
  const byId = db.prepare('SELECT id FROM images WHERE id = ?').get(parseInt(target));
  return byId ? byId.id : null;
}

function getGalleryRole(galleryId, userUuid) {
  if (!userUuid) return null;
  const row = db.prepare(
    'SELECT role FROM gallery_collaborators WHERE gallery_id = ? AND user_uuid = ?'
  ).get(galleryId, userUuid);
  return row ? row.role : null;
}

function userCanAddRemove(galleryId, userUuid, isAdmin) {
  if (isAdmin) return true;
  const role = getGalleryRole(galleryId, userUuid);
  return role === 'owner' || role === 'admin' || role === 'user';
}

function userCanManage(galleryId, userUuid, isAdmin) {
  if (isAdmin) return true;
  const role = getGalleryRole(galleryId, userUuid);
  return role === 'owner' || role === 'admin';
}

function userIsOwner(galleryId, userUuid, isAdmin) {
  if (isAdmin) return true;
  return getGalleryRole(galleryId, userUuid) === 'owner';
}

function resolveGallery(identifier, userUuid, isAdmin) {
  let row = db.prepare('SELECT * FROM galleries WHERE uuid = ?').get(identifier);
  if (!row && !isNaN(parseInt(identifier))) {
    row = db.prepare('SELECT * FROM galleries WHERE id = ?').get(parseInt(identifier));
  }
  if (!row) return null;
  if (isAdmin) return row;
  if (userUuid && getGalleryRole(row.id, userUuid)) return row;
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

function mapGalleryRow(row, userUuid) {
  const role = userUuid ? getGalleryRole(row.id, userUuid) : null;
  return {
    ...row,
    is_archived: row.is_archived || 0,
    is_public_editable: row.is_public_editable || 0,
    my_role: role,
    collaborators_count: db.prepare(
      'SELECT COUNT(*) AS cnt FROM gallery_collaborators WHERE gallery_id = ?'
    ).get(row.id).cnt,
  };
}

/**
 * @swagger
 * /api/galleries:
 *   get:
 *     tags: [Galleries]
 *     summary: 获取照片夹列表
 *     description: 获取当前用户有权限访问的所有照片夹列表（拥有、协同或公开的），管理员可查看全部
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: 照片夹列表
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 galleries:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       uuid: { type: string }
 *                       name: { type: string }
 *                       description: { type: string }
 *                       creator_uuid: { type: string }
 *                       is_public: { type: integer }
 *                       is_archived: { type: integer }
 *                       is_public_editable: { type: integer }
 *                       my_role: { type: string, nullable: true }
 *                       image_count: { type: integer }
 *                       collaborators_count: { type: integer }
 *       401:
 *         description: 未登录
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiError'
 */
router.get('/', requireAuth, (req, res) => {
  const userUuid = getUserUuid(req);
  if (!userUuid) return res.status(401).json({ error: '未登录' });

  let rows;
  if (isAdminUser(req)) {
    rows = db.prepare(`
      SELECT g.*, (SELECT COUNT(*) FROM gallery_images gi WHERE gi.gallery_id = g.id) AS image_count
      FROM galleries g
      ORDER BY g.updated_at DESC
    `).all();
  } else {
    rows = db.prepare(`
      SELECT g.*, (SELECT COUNT(*) FROM gallery_images gi WHERE gi.gallery_id = g.id) AS image_count
      FROM galleries g
      LEFT JOIN gallery_collaborators gc ON gc.gallery_id = g.id AND gc.user_uuid = ?
      WHERE g.creator_uuid = ? OR gc.user_uuid IS NOT NULL
      GROUP BY g.id
      ORDER BY g.updated_at DESC
    `).all(userUuid, userUuid);
  }

  res.json({ galleries: rows.map(r => mapGalleryRow(r, userUuid)) });
});

/**
 * @swagger
 * /api/galleries:
 *   post:
 *     tags: [Galleries]
 *     summary: 创建照片夹
 *     description: 创建新的照片夹，创建者自动成为 owner 协作者
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
 *                 description: 照片夹名称
 *               description:
 *                 type: string
 *                 description: 照片夹描述
 *               is_public:
 *                 type: boolean
 *                 default: true
 *                 description: 是否公开
 *     responses:
 *       201:
 *         description: 创建成功
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 gallery:
 *                   type: object
 *                   properties:
 *                     uuid: { type: string }
 *                     name: { type: string }
 *       400:
 *         description: 名称为空
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
  db.prepare('INSERT OR IGNORE INTO gallery_collaborators (gallery_id, user_uuid, role) VALUES (?, ?, ?)').run(gallery.id, userUuid, 'owner');
  logGalleryCreate(req, gallery);
  res.status(201).json({ gallery: mapGalleryRow(gallery, userUuid) });
});

/**
 * @swagger
 * /api/galleries/{uuid}/images:
 *   post:
 *     tags: [Galleries]
 *     summary: 向照片夹添加图片
 *     description: 向指定照片夹添加图片（需有 owner/admin/user 角色）。已归档照片夹不可添加。
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: uuid
 *         required: true
 *         schema: { type: string }
 *         description: 照片夹UUID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [image_uuids]
 *             properties:
 *               image_uuids:
 *                 type: array
 *                 items: { type: string }
 *                 description: 图片UUID列表
 *     responses:
 *       200:
 *         description: 添加结果
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message: { type: string }
 *                 added: { type: integer }
 *                 skipped: { type: integer }
 *       400:
 *         description: 参数错误或照片夹已归档
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
 *         description: 照片夹不存在
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiError'
 */
router.post('/:uuid/images', requireAuth, (req, res) => {
  const userUuid = getUserUuid(req);
  const gallery = resolveGallery(req.params.uuid, userUuid, isAdminUser(req));

  if (!gallery) return res.status(404).json({ error: '照片夹不存在' });
  if (!userCanAddRemove(gallery.id, userUuid, isAdminUser(req))) {
    return res.status(403).json({ error: '无权操作此照片夹' });
  }
  if (gallery.is_archived) {
    return res.status(400).json({ error: '照片夹已归档，无法添加图片' });
  }

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

/**
 * @swagger
 * /api/galleries/{uuid}/images:
 *   delete:
 *     tags: [Galleries]
 *     summary: 从照片夹移除图片
 *     description: 从指定照片夹移除图片（需有 owner/admin/user 角色）。已归档照片夹不可移除。
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: uuid
 *         required: true
 *         schema: { type: string }
 *         description: 照片夹UUID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [image_uuids]
 *             properties:
 *               image_uuids:
 *                 type: array
 *                 items: { type: string }
 *                 description: 图片UUID列表
 *     responses:
 *       200:
 *         description: 移除结果
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message: { type: string }
 *                 removed: { type: integer }
 *       400:
 *         description: 参数错误或照片夹已归档
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
 *         description: 照片夹不存在
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiError'
 */
router.delete('/:uuid/images', requireAuth, (req, res) => {
  const userUuid = getUserUuid(req);
  const gallery = resolveGallery(req.params.uuid, userUuid, isAdminUser(req));

  if (!gallery) return res.status(404).json({ error: '照片夹不存在' });
  if (!userCanAddRemove(gallery.id, userUuid, isAdminUser(req))) {
    return res.status(403).json({ error: '无权操作此照片夹' });
  }
  if (gallery.is_archived) {
    return res.status(400).json({ error: '照片夹已归档，无法移除图片' });
  }

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

/**
 * @swagger
 * /api/galleries/{uuid}/download:
 *   get:
 *     tags: [Galleries]
 *     summary: 下载照片夹内所有图片为压缩包
 *     description: 将照片夹内的所有图片压缩后打包为 ZIP 下载，支持输出格式调整。
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: uuid
 *         required: true
 *         schema: { type: string }
 *         description: 照片夹UUID
 *       - in: query
 *         name: format
 *         schema: { type: string, enum: [jpeg, png, webp], default: jpeg }
 *         description: 输出图片格式
 *       - in: query
 *         name: q
 *         schema: { type: integer, default: 85 }
 *         description: 图片质量（1-100）
 *       - in: query
 *         name: w
 *         schema: { type: integer }
 *         description: 最大宽度（像素），不传则不缩放
 *       - in: query
 *         name: m
 *         schema: { type: string }
 *         description: 水印文件名（可选）
 *       - in: query
 *         name: filename
 *         schema: { type: string }
 *         description: 下载的 ZIP 文件名（不含 .zip 后缀，默认使用照片夹名）
 *     responses:
 *       200:
 *         description: ZIP 文件流
 *         content:
 *           application/zip:
 *             schema:
 *               type: string
 *               format: binary
 *       400:
 *         description: 照片夹中没有图片
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiError'
 *       404:
 *         description: 照片夹不存在
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiError'
 */
router.get('/:uuid/download', requireAuth, async (req, res) => {
  const userUuid = getUserUuid(req);
  const gallery = resolveGallery(req.params.uuid, userUuid, isAdminUser(req));

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

  const zipName = req.query.filename || gallery.name;
  await streamZipDownload(res, imageRows, zipName, req.query);
});

/**
 * @swagger
 * /api/galleries/{uuid}:
 *   get:
 *     tags: [Galleries]
 *     summary: 获取照片夹详情
 *     description: 获取照片夹详情及其图片列表（分页），支持通过 uuid 或 id 定位
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: uuid
 *         required: true
 *         schema: { type: string }
 *         description: 照片夹UUID
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *         description: 页码
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20 }
 *         description: 每页数量（最大100）
 *     responses:
 *       200:
 *         description: 照片夹详情
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 gallery:
 *                   type: object
 *                 images:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Image'
 *                 collaborators:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       user_uuid: { type: string }
 *                       role: { type: string }
 *                 pagination:
 *                   $ref: '#/components/schemas/Pagination'
 *       404:
 *         description: 照片夹不存在
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiError'
 */
router.get('/:uuid', requireAuth, (req, res) => {
  const userUuid = getUserUuid(req);
  const gallery = resolveGallery(req.params.uuid, userUuid, isAdminUser(req));

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

  const collaborators = db.prepare(
    'SELECT user_uuid, role FROM gallery_collaborators WHERE gallery_id = ?'
  ).all(gallery.id);

  res.json({
    gallery: mapGalleryRow(gallery, userUuid),
    images: imageRows.map(formatImage),
    collaborators: collaborators.map(c => ({ user_uuid: c.user_uuid, role: c.role })),
    pagination: {
      page,
      limit,
      total: countRow.total,
      total_pages: Math.ceil(countRow.total / limit),
    },
  });
});

/**
 * @swagger
 * /api/galleries/{uuid}:
 *   put:
 *     tags: [Galleries]
 *     summary: 更新照片夹
 *     description: 更新照片夹的名称、描述、公开状态（owner/admin 可修改）。公开可编辑开关仅管理员可设置。
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: uuid
 *         required: true
 *         schema: { type: string }
 *         description: 照片夹UUID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *                 description: 照片夹名称
 *               description:
 *                 type: string
 *                 description: 照片夹描述
 *               is_public:
 *                 type: integer
 *                 enum: [0, 1]
 *                 description: 是否公开
 *               is_public_editable:
 *                 type: integer
 *                 enum: [0, 1]
 *                 description: 是否公开可编辑（仅管理员可设置）
 *     responses:
 *       200:
 *         description: 更新成功
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 gallery:
 *                   type: object
 *       400:
 *         description: 名称为空
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
 *         description: 照片夹不存在
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiError'
 */
router.put('/:uuid', requireAuth, (req, res) => {
  const userUuid = getUserUuid(req);
  const gallery = resolveGallery(req.params.uuid, userUuid, isAdminUser(req));

  if (!gallery) return res.status(404).json({ error: '照片夹不存在' });
  if (!userCanManage(gallery.id, userUuid, isAdminUser(req))) {
    return res.status(403).json({ error: '无权修改此照片夹' });
  }

  const before = { name: gallery.name, description: gallery.description, is_public: gallery.is_public, is_public_editable: gallery.is_public_editable };
  const { name, description, is_public, is_public_editable } = req.body;

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

  if (is_public_editable !== undefined && isAdminUser(req)) {
    db.prepare('UPDATE galleries SET is_public_editable = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(is_public_editable ? 1 : 0, gallery.id);
  }

  const updated = db.prepare('SELECT * FROM galleries WHERE id = ?').get(gallery.id);
  logGalleryUpdate(req, gallery.uuid, before, {
    name: updated.name, description: updated.description, is_public: updated.is_public, is_public_editable: updated.is_public_editable,
  });
  res.json({ gallery: mapGalleryRow(updated, userUuid) });
});

/**
 * @swagger
 * /api/galleries/{uuid}:
 *   delete:
 *     tags: [Galleries]
 *     summary: 删除照片夹
 *     description: 删除照片夹（仅 owner 可删除）
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: uuid
 *         required: true
 *         schema: { type: string }
 *         description: 照片夹UUID
 *     responses:
 *       200:
 *         description: 删除成功
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message: { type: string }
 *       403:
 *         description: 无权限（非 owner）
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiError'
 *       404:
 *         description: 照片夹不存在
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiError'
 */
router.delete('/:uuid', requireAuth, (req, res) => {
  const userUuid = getUserUuid(req);
  const gallery = resolveGallery(req.params.uuid, userUuid, isAdminUser(req));

  if (!gallery) return res.status(404).json({ error: '照片夹不存在' });
  if (!userIsOwner(gallery.id, userUuid, isAdminUser(req))) {
    return res.status(403).json({ error: '无权删除此照片夹，仅owner可删除' });
  }

  logGalleryDelete(req, gallery.uuid, gallery.name);
  db.prepare('DELETE FROM galleries WHERE id = ?').run(gallery.id);
  res.json({ message: '照片夹已删除' });
});

/**
 * @swagger
 * /api/galleries/{uuid}/archive:
 *   post:
 *     tags: [Galleries]
 *     summary: 归档照片夹
 *     description: 归档照片夹（仅 owner 可操作），归档后不可添加/移除图片
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: uuid
 *         required: true
 *         schema: { type: string }
 *         description: 照片夹UUID
 *     responses:
 *       200:
 *         description: 归档成功
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message: { type: string }
 *       403:
 *         description: 无权限
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiError'
 *       404:
 *         description: 照片夹不存在
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiError'
 */
router.post('/:uuid/archive', requireAuth, (req, res) => {
  const userUuid = getUserUuid(req);
  const gallery = resolveGallery(req.params.uuid, userUuid, isAdminUser(req));

  if (!gallery) return res.status(404).json({ error: '照片夹不存在' });
  if (!userIsOwner(gallery.id, userUuid, isAdminUser(req))) {
    return res.status(403).json({ error: '仅owner可归档照片夹' });
  }

  db.prepare('UPDATE galleries SET is_archived = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(gallery.id);
  res.json({ message: '照片夹已归档', gallery: mapGalleryRow({ ...gallery, is_archived: 1 }, userUuid) });
});

/**
 * @swagger
 * /api/galleries/{uuid}/unarchive:
 *   post:
 *     tags: [Galleries]
 *     summary: 取消归档
 *     description: 取消归档照片夹（仅 owner 可操作），恢复后可正常添加/移除图片
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: uuid
 *         required: true
 *         schema: { type: string }
 *         description: 照片夹UUID
 *     responses:
 *       200:
 *         description: 取消归档成功
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message: { type: string }
 *       403:
 *         description: 无权限
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiError'
 *       404:
 *         description: 照片夹不存在
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiError'
 */
router.post('/:uuid/unarchive', requireAuth, (req, res) => {
  const userUuid = getUserUuid(req);
  const gallery = resolveGallery(req.params.uuid, userUuid, isAdminUser(req));

  if (!gallery) return res.status(404).json({ error: '照片夹不存在' });
  if (!userIsOwner(gallery.id, userUuid, isAdminUser(req))) {
    return res.status(403).json({ error: '仅owner可取消归档' });
  }

  db.prepare('UPDATE galleries SET is_archived = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(gallery.id);
  res.json({ message: '已取消归档', gallery: mapGalleryRow({ ...gallery, is_archived: 0 }, userUuid) });
});

/**
 * @swagger
 * /api/galleries/{uuid}/transfer:
 *   post:
 *     tags: [Galleries]
 *     summary: 转移照片夹所有权
 *     description: 将照片夹所有权转移给另一个用户（仅 owner 可操作）。原 owner 降为 user 角色。
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: uuid
 *         required: true
 *         schema: { type: string }
 *         description: 照片夹UUID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [target_user_uuid]
 *             properties:
 *               target_user_uuid:
 *                 type: string
 *                 description: 目标用户UUID
 *     responses:
 *       200:
 *         description: 转移成功
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message: { type: string }
 *       400:
 *         description: 参数错误或目标用户不存在
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
 *         description: 照片夹不存在
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiError'
 */
router.post('/:uuid/transfer', requireAuth, (req, res) => {
  const userUuid = getUserUuid(req);
  const gallery = resolveGallery(req.params.uuid, userUuid, isAdminUser(req));

  if (!gallery) return res.status(404).json({ error: '照片夹不存在' });
  if (!userIsOwner(gallery.id, userUuid, isAdminUser(req))) {
    return res.status(403).json({ error: '仅owner可转移照片夹' });
  }

  const { target_user_uuid } = req.body || {};
  if (!target_user_uuid) return res.status(400).json({ error: '请提供目标用户UUID' });

  const targetUser = db.prepare('SELECT uuid FROM users WHERE uuid = ?').get(target_user_uuid);
  if (!targetUser) return res.status(400).json({ error: '目标用户不存在' });
  if (targetUser.uuid === userUuid) return res.status(400).json({ error: '不能转移给自己' });

  const useTransaction = db.transaction(() => {
    db.prepare('UPDATE galleries SET creator_uuid = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(targetUserUuid, gallery.id);
    db.prepare('DELETE FROM gallery_collaborators WHERE gallery_id = ? AND user_uuid = ?').run(gallery.id, targetUserUuid);
    db.prepare('INSERT OR REPLACE INTO gallery_collaborators (gallery_id, user_uuid, role) VALUES (?, ?, ?)').run(gallery.id, targetUserUuid, 'owner');
    db.prepare('DELETE FROM gallery_collaborators WHERE gallery_id = ? AND user_uuid = ?').run(gallery.id, userUuid);
    db.prepare('INSERT OR REPLACE INTO gallery_collaborators (gallery_id, user_uuid, role) VALUES (?, ?, ?)').run(gallery.id, userUuid, 'user');
  });
  useTransaction();

  res.json({ message: '照片夹已转移' });
});

/**
 * @swagger
 * /api/galleries/{uuid}/collaborators:
 *   get:
 *     tags: [Galleries]
 *     summary: 获取照片夹协同用户
 *     description: 获取照片夹的协同用户列表
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: uuid
 *         required: true
 *         schema: { type: string }
 *         description: 照片夹UUID
 *     responses:
 *       200:
 *         description: 协同用户列表
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 collaborators:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       user_uuid: { type: string }
 *                       role: { type: string }
 *                       added_at: { type: string, format: date-time }
 *       404:
 *         description: 照片夹不存在
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiError'
 */
router.get('/:uuid/collaborators', requireAuth, (req, res) => {
  const userUuid = getUserUuid(req);
  const gallery = resolveGallery(req.params.uuid, userUuid, isAdminUser(req));

  if (!gallery) return res.status(404).json({ error: '照片夹不存在' });

  const rows = db.prepare(
    'SELECT user_uuid, role, added_at FROM gallery_collaborators WHERE gallery_id = ? ORDER BY role, added_at'
  ).all(gallery.id);

  res.json({ collaborators: rows });
});

/**
 * @swagger
 * /api/galleries/{uuid}/collaborators:
 *   post:
 *     tags: [Galleries]
 *     summary: 添加/更新协同用户
 *     description: 向照片夹添加协同用户或更新其角色（需 owner/admin 权限）。不能修改 owner 角色。
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: uuid
 *         required: true
 *         schema: { type: string }
 *         description: 照片夹UUID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [user_uuid]
 *             properties:
 *               user_uuid:
 *                 type: string
 *                 description: 目标用户UUID
 *               role:
 *                 type: string
 *                 enum: [admin, user]
 *                 default: user
 *                 description: 角色
 *     responses:
 *       200:
 *         description: 更新成功
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message: { type: string }
 *       400:
 *         description: 参数错误或目标用户不存在
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
 *         description: 照片夹不存在
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiError'
 */
router.post('/:uuid/collaborators', requireAuth, (req, res) => {
  const userUuid = getUserUuid(req);
  const gallery = resolveGallery(req.params.uuid, userUuid, isAdminUser(req));

  if (!gallery) return res.status(404).json({ error: '照片夹不存在' });
  if (!userCanManage(gallery.id, userUuid, isAdminUser(req))) {
    return res.status(403).json({ error: '无权管理此照片夹的协同用户' });
  }

  const { user_uuid: targetUuid, role } = req.body || {};
  if (!targetUuid) return res.status(400).json({ error: '请提供目标用户UUID' });
  const targetRole = role || 'user';
  if (!['admin', 'user'].includes(targetRole)) {
    return res.status(400).json({ error: '角色只能是admin或user' });
  }

  const targetUser = db.prepare('SELECT uuid FROM users WHERE uuid = ?').get(targetUuid);
  if (!targetUser) return res.status(400).json({ error: '目标用户不存在' });

  const existing = db.prepare(
    'SELECT role FROM gallery_collaborators WHERE gallery_id = ? AND user_uuid = ?'
  ).get(gallery.id, targetUuid);

  if (existing) {
    if (existing.role === 'owner') return res.status(400).json({ error: '不能修改owner角色' });
    db.prepare('UPDATE gallery_collaborators SET role = ? WHERE gallery_id = ? AND user_uuid = ?').run(targetRole, gallery.id, targetUuid);
  } else {
    db.prepare('INSERT OR IGNORE INTO gallery_collaborators (gallery_id, user_uuid, role) VALUES (?, ?, ?)').run(gallery.id, targetUuid, targetRole);
  }

  res.json({ message: '协同用户已更新' });
});

/**
 * @swagger
 * /api/galleries/{uuid}/collaborators/{collabUuid}:
 *   delete:
 *     tags: [Galleries]
 *     summary: 移除协同用户
 *     description: 从照片夹移除协同用户（需 owner/admin 权限）。不能移除 owner。
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: uuid
 *         required: true
 *         schema: { type: string }
 *         description: 照片夹UUID
 *       - in: path
 *         name: collabUuid
 *         required: true
 *         schema: { type: string }
 *         description: 协同用户UUID
 *     responses:
 *       200:
 *         description: 移除成功
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message: { type: string }
 *       400:
 *         description: 不能移除owner
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
 *         description: 照片夹或协同用户不存在
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiError'
 */
router.delete('/:uuid/collaborators/:collabUuid', requireAuth, (req, res) => {
  const userUuid = getUserUuid(req);
  const gallery = resolveGallery(req.params.uuid, userUuid, isAdminUser(req));

  if (!gallery) return res.status(404).json({ error: '照片夹不存在' });
  if (!userCanManage(gallery.id, userUuid, isAdminUser(req))) {
    return res.status(403).json({ error: '无权管理此照片夹的协同用户' });
  }

  const collabUuid = req.params.collabUuid;
  const collab = db.prepare(
    'SELECT role FROM gallery_collaborators WHERE gallery_id = ? AND user_uuid = ?'
  ).get(gallery.id, collabUuid);
  if (!collab) return res.status(404).json({ error: '协同用户不存在' });
  if (collab.role === 'owner') return res.status(400).json({ error: '不能移除owner' });

  db.prepare('DELETE FROM gallery_collaborators WHERE gallery_id = ? AND user_uuid = ?').run(gallery.id, collabUuid);
  res.json({ message: '已移除协同用户' });
});

/**
 * @swagger
 * /api/galleries/like:
 *   post:
 *     tags: [Galleries]
 *     summary: 切换图片喜爱状态
 *     description: 将图片添加到默认喜爱照片夹或移除。需要先在用户设置中指定默认照片夹。
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [image_uuid]
 *             properties:
 *               image_uuid:
 *                 type: string
 *                 description: 图片UUID
 *               action:
 *                 type: string
 *                 enum: [add]
 *                 description: 传 'add' 时，如已存在则返回 already=true 而不取消
 *     responses:
 *       200:
 *         description: 操作结果
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 liked: { type: boolean }
 *                 already: { type: boolean }
 *                 gallery_uuid: { type: string }
 *       400:
 *         description: 参数错误或未设置默认照片夹
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
 *         description: 默认照片夹不可访问
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiError'
 */
router.post('/like', requireAuth, (req, res) => {
  const userUuid = getUserUuid(req);
  if (!userUuid) return res.status(401).json({ error: '未登录' });

  const { image_uuid, action } = req.body || {};
  if (!image_uuid) return res.status(400).json({ error: '请提供图片UUID' });

  const imageId = resolveImageId(image_uuid);
  if (!imageId) return res.status(400).json({ error: '图片不存在' });

  const defaultGalleryUuid = db.prepare(
    'SELECT default_gallery_uuid FROM users WHERE uuid = ?'
  ).get(userUuid)?.default_gallery_uuid;

  if (!defaultGalleryUuid) {
    return res.status(400).json({ error: '请先在设置中选择一个喜欢文件夹', code: 'no_default_gallery' });
  }

  const gallery = db.prepare('SELECT * FROM galleries WHERE uuid = ?').get(defaultGalleryUuid);
  if (!gallery) {
    return res.status(400).json({ error: '喜欢文件夹已被删除，请在设置中重新选择', code: 'no_default_gallery' });
  }

  const role = getGalleryRole(gallery.id, userUuid);
  if (!role && !isAdminUser(req)) {
    return res.status(403).json({ error: '你喜欢文件夹已被删除或不再可访问', code: 'no_default_gallery' });
  }

  const existing = db.prepare(
    'SELECT 1 FROM gallery_images WHERE gallery_id = ? AND image_id = ?'
  ).get(gallery.id, imageId);

  if (existing) {
    if (action === 'add') {
      res.json({ liked: true, already: true, gallery_uuid: gallery.uuid });
    } else {
      db.prepare(
        'DELETE FROM gallery_images WHERE gallery_id = ? AND image_id = ?'
      ).run(gallery.id, imageId);
      db.prepare('UPDATE galleries SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(gallery.id);
      res.json({ liked: false, gallery_uuid: gallery.uuid });
    }
  } else {
    db.prepare(
      'INSERT OR IGNORE INTO gallery_images (gallery_id, image_id) VALUES (?, ?)'
    ).run(gallery.id, imageId);
    db.prepare('UPDATE galleries SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(gallery.id);
    res.json({ liked: true, gallery_uuid: gallery.uuid });
  }
});

/**
 * @swagger
 * /api/galleries/like/status:
 *   get:
 *     tags: [Galleries]
 *     summary: 获取已喜爱的图片UUID列表
 *     description: 返回当前用户所喜爱（在默认照片夹中）的所有图片UUID
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: 已喜爱图片UUID列表
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 liked_uuids:
 *                   type: array
 *                   items: { type: string }
 *       401:
 *         description: 未登录
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiError'
 */
router.get('/like/status', requireAuth, (req, res) => {
  const userUuid = getUserUuid(req);
  if (!userUuid) return res.status(401).json({ error: '未登录' });

  const defaultGalleryUuid = db.prepare(
    'SELECT default_gallery_uuid FROM users WHERE uuid = ?'
  ).get(userUuid)?.default_gallery_uuid;

  if (!defaultGalleryUuid) return res.json({ liked_uuids: [] });

  const gallery = db.prepare('SELECT id FROM galleries WHERE uuid = ?').get(defaultGalleryUuid);
  if (!gallery) return res.json({ liked_uuids: [] });

  const rows = db.prepare(`
    SELECT i.uuid FROM images i
    INNER JOIN gallery_images gi ON gi.image_id = i.id
    WHERE gi.gallery_id = ?
  `).all(gallery.id);

  res.json({ liked_uuids: rows.map(r => r.uuid) });
});

export default router;
