import { Router } from 'express';
import config from '../config/app.js';

const router = Router();

router.get('/', (_req, res) => {
  res.json({
    maxFileSizeMB: config.maxFileSizeMB,
    maxFileSizeBytes: config.maxFileSizeMB * 1024 * 1024,
    maxBatchCount: config.maxBatchCount,
    allowedTypes: config.allowedTypes,
  });
});

export default router;
