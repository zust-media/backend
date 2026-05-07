import express from 'express';
import cors from 'cors';
import swaggerUi from 'swagger-ui-express';
import swaggerSpec from './config/swagger.js';
import { basename, extname } from 'path';
import './config/database.js';
import config from './config/app.js';
import { authenticate } from './middleware/auth.js';
import { requireValidSig } from './utils/signing.js';
import { serveImage } from './utils/thumbnail.js';
import authRoutes from './routes/auth.js';
import imagesRoutes from './routes/images.js';
import tagsRoutes from './routes/tags.js';
import configRoutes from './routes/config.js';
import usersRoutes from './routes/users.js';
import categoriesRoutes from './routes/categories.js';
import adminRoutes from './routes/admin.js';

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors({
  origin(_origin, callback) {
    callback(null, true);
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  maxAge: 86400,
}));

app.use(express.json());
app.use(authenticate);

app.use('/api/auth', authRoutes);
app.use('/api/images', imagesRoutes);
app.use('/api/tags', tagsRoutes);
app.use('/api/config', configRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/categories', categoriesRoutes);
app.use('/api/admin', adminRoutes);

app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));
app.get('/api/docs.json', (_req, res) => res.json(swaggerSpec));

app.get('/api/img/:filename', requireValidSig, async (req, res) => {
  const filename = basename(req.params.filename);
  const isDownload = req.query.dl === '1';
  const mimeType = extname(filename).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg';

  try {
    const buffer = await serveImage(filename, req.query);
    if (!buffer) {
      return res.status(404).json({ error: '图片不存在或处理失败' });
    }

    res.setHeader('Content-Type', mimeType);
    if (isDownload) {
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    } else {
      res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
    }
    res.setHeader('Content-Length', buffer.length);
    res.end(buffer);
  } catch (err) {
    console.error('图片处理端点错误:', err.message);
    res.status(500).json({ error: '图片处理失败' });
  }
});

app.use((_req, res) => {
  res.status(404).json({ error: '接口不存在' });
});

app.use((err, _req, res, _next) => {
  console.error(err);
  if (err.type === 'entity.too.large') {
    return res.status(400).json({ error: `文件大小超过限制（最大${config.maxFileSizeMB}MB）` });
  }
  res.status(500).json({ error: '服务器内部错误' });
});

app.listen(PORT, () => {
  console.log(`ZustMedia API 服务器已启动: http://localhost:${PORT}`);
  console.log(`默认管理员账号: admin / admin123`);
  console.log(`默认用户账号: user / user123`);
});
