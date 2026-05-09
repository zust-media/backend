import crypto from 'crypto';
import db from '../config/database.js';

function resolveOperatorUuid(req) {
  if (req.user && req.user.user_id) {
    const row = db.prepare('SELECT uuid FROM users WHERE id = ?').get(req.user.user_id);
    return row ? row.uuid : 'unknown';
  }
  return 'anonymous';
}

export function logActivity(req, action, data) {
  try {
    const uuid = crypto.randomUUID();
    const operator = resolveOperatorUuid(req);
    db.prepare(
      'INSERT INTO activity_log (uuid, operator, action, data, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(uuid, operator, action, JSON.stringify(data), new Date().toISOString());
  } catch (err) {
    console.error('activity_log insert failed:', err.message);
  }
}

export function logImageUpload(req, image) {
  logActivity(req, 'image.upload', {
    version: '1.0',
    entity_type: 'image',
    entity_id: image.uuid,
    is_duplicate: image.is_duplicate || false,
    duplicate_of: image.duplicate_of || null,
    detail: {
      image: {
        id: image.id,
        uuid: image.uuid,
        original_name: image.original_name,
        file_size: image.file_size,
        mime_type: image.mime_type,
        title: image.title || '',
      },
    },
  });
}

export function logImageDelete(req, image) {
  logActivity(req, 'image.delete', {
    version: '1.0',
    entity_type: 'image',
    entity_id: image.uuid,
    detail: {
      image: {
        id: image.id,
        uuid: image.uuid,
        original_name: image.original_name,
        file_size: image.file_size,
        title: image.title || '',
      },
    },
  });
}

export function logImageEdit(req, imageId, imageUuid, before, after) {
  logActivity(req, 'image.edit', {
    version: '1.0',
    entity_type: 'image',
    entity_id: imageUuid,
    detail: { before, after },
  });
}

export function logBatchImageDelete(req, ids, uuids) {
  logActivity(req, 'image.batch_delete', {
    version: '1.0',
    detail: { count: ids.length, image_ids: ids, image_uuids: uuids },
  });
}

export function logBatchImageUpdate(req, ids, uuids, changes) {
  logActivity(req, 'image.batch_update', {
    version: '1.0',
    detail: { count: ids.length, image_ids: ids, image_uuids: uuids, changes },
  });
}

export function logUserCreate(req, user) {
  logActivity(req, 'user.create', {
    version: '1.0',
    entity_type: 'user',
    entity_id: user.uuid,
    detail: {
      user: {
        id: user.id,
        uuid: user.uuid,
        username: user.username,
        nickname: user.nickname || '',
        role: user.role,
      },
    },
  });
}

export function logUserUpdate(req, userId, userUuid, before, after) {
  logActivity(req, 'user.update', {
    version: '1.0',
    entity_type: 'user',
    entity_id: userUuid,
    detail: { before, after },
  });
}

export function logUserDelete(req, user) {
  logActivity(req, 'user.delete', {
    version: '1.0',
    entity_type: 'user',
    entity_id: user.uuid,
    detail: {
      user: {
        id: user.id,
        uuid: user.uuid,
        username: user.username,
        role: user.role,
      },
    },
  });
}

export function logTagCreate(req, tagName, tagSlug) {
  logActivity(req, 'tag.create', {
    version: '1.0',
    entity_type: 'tag',
    entity_id: tagSlug,
    detail: { tag: { name: tagName, slug: tagSlug } },
  });
}

export function logTagUpdate(req, tagId, tagSlug, before, after) {
  logActivity(req, 'tag.update', {
    version: '1.0',
    entity_type: 'tag',
    entity_id: tagSlug,
    detail: { before, after },
  });
}

export function logTagDelete(req, tagName, tagSlug) {
  logActivity(req, 'tag.delete', {
    version: '1.0',
    entity_type: 'tag',
    entity_id: tagSlug,
    detail: { tag: { name: tagName, slug: tagSlug } },
  });
}

export function logCategoryCreate(req, catName, catSlug) {
  logActivity(req, 'category.create', {
    version: '1.0',
    entity_type: 'category',
    entity_id: catSlug,
    detail: { category: { name: catName, slug: catSlug } },
  });
}

export function logCategoryUpdate(req, catId, catSlug, before, after) {
  logActivity(req, 'category.update', {
    version: '1.0',
    entity_type: 'category',
    entity_id: catSlug,
    detail: { before, after },
  });
}

export function logCategoryDelete(req, catName, catSlug) {
  logActivity(req, 'category.delete', {
    version: '1.0',
    entity_type: 'category',
    entity_id: catSlug,
    detail: { category: { name: catName, slug: catSlug } },
  });
}

export function logGalleryCreate(req, gallery) {
  logActivity(req, 'gallery.create', {
    version: '1.0',
    entity_type: 'gallery',
    entity_id: gallery.uuid,
    detail: { gallery: { name: gallery.name, uuid: gallery.uuid } },
  });
}

export function logGalleryUpdate(req, galleryUuid, before, after) {
  logActivity(req, 'gallery.update', {
    version: '1.0',
    entity_type: 'gallery',
    entity_id: galleryUuid,
    detail: { before, after },
  });
}

export function logGalleryDelete(req, galleryUuid, galleryName) {
  logActivity(req, 'gallery.delete', {
    version: '1.0',
    entity_type: 'gallery',
    entity_id: galleryUuid,
    detail: { gallery: { name: galleryName, uuid: galleryUuid } },
  });
}

export function logGalleryAddImages(req, galleryUuid, imageUuids) {
  logActivity(req, 'gallery.add_images', {
    version: '1.0',
    entity_type: 'gallery',
    entity_id: galleryUuid,
    detail: { count: imageUuids.length, image_uuids: imageUuids },
  });
}

export function logGalleryRemoveImages(req, galleryUuid, imageUuids) {
  logActivity(req, 'gallery.remove_images', {
    version: '1.0',
    entity_type: 'gallery',
    entity_id: galleryUuid,
    detail: { count: imageUuids.length, image_uuids: imageUuids },
  });
}
