import { Router } from 'express';
import db from '../config/database.js';
import { requireAdmin } from '../middleware/auth.js';

const router = Router();

/**
 * @swagger
 * tags:
 *   name: Admin
 *   description: 管理接口（仅管理员）
 */

/**
 * @swagger
 * /api/admin/stats:
 *   get:
 *     tags: [Admin]
 *     summary: 站点统计数据
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: 统计数据 }
 *       403: { description: 非管理员 }
 */
router.get('/stats', requireAdmin, (_req, res) => {
  const totalUsers = db.prepare('SELECT COUNT(*) as cnt FROM users').get().cnt;
  const totalImages = db.prepare('SELECT COUNT(*) as cnt FROM images').get().cnt;
  const totalCategories = db.prepare('SELECT COUNT(*) as cnt FROM categories').get().cnt;
  const totalTags = db.prepare('SELECT COUNT(*) as cnt FROM tags').get().cnt;

  const totalSize = db.prepare('SELECT SUM(file_size) as total FROM images').get().total || 0;

  const recentImages = db.prepare(`
    SELECT i.id, i.title, i.original_name, i.file_size, i.created_at, u.username
    FROM images i JOIN users u ON i.user_id = u.id
    ORDER BY i.created_at DESC LIMIT 5
  `).all();

  const topUploaders = db.prepare(`
    SELECT u.username, u.role, COUNT(i.id) as cnt
    FROM users u LEFT JOIN images i ON i.user_id = u.id
    GROUP BY u.id ORDER BY cnt DESC LIMIT 5
  `).all();

  res.json({
    totalUsers,
    totalImages,
    totalCategories,
    totalTags,
    totalSize,
    recentImages,
    topUploaders,
  });
});

export default router;
