import { Router } from 'express';
import config from '../config/app.js';

const router = Router();

/**
 * @swagger
 * tags:
 *   name: Config
 *   description: 系统配置
 */

/**
 * @swagger
 * /api/config:
 *   get:
 *     tags: [Config]
 *     summary: 获取系统配置
 *     description: 获取系统的公开配置信息，包括最大文件大小、允许的文件类型、批量上传数量等
 *     responses:
 *       200:
 *         description: 系统配置
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 maxFileSizeMB:
 *                   type: number
 *                   description: 最大文件大小（MB）
 *                 maxFileSizeBytes:
 *                   type: number
 *                   description: 最大文件大小（字节）
 *                 maxBatchCount:
 *                   type: integer
 *                   description: 批量上传最大数量
 *                 allowedTypes:
 *                   type: array
 *                   items: { type: string }
 *                   description: 允许的 MIME 类型列表
 */
router.get('/', (_req, res) => {
  res.json({
    maxFileSizeMB: config.maxFileSizeMB,
    maxFileSizeBytes: config.maxFileSizeMB * 1024 * 1024,
    maxBatchCount: config.maxBatchCount,
    allowedTypes: config.allowedTypes,
  });
});

export default router;
