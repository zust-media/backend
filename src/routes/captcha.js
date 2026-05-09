import { Router } from 'express';
import svgCaptcha from 'svg-captcha';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { setCaptcha, getCaptcha, deleteCaptcha, setRegToken } from '../config/captcha-store.js';
import config from '../config/app.js';

const router = Router();
const CAPTCHA_JWT_SECRET = config.security.captchaJwtSecret;

/**
 * @swagger
 * tags:
 *   name: Registration Captcha
 *   description: 注册验证码流程接口
 */

/**
 * @swagger
 * /api/auth/captcha/generate:
 *   get:
 *     tags: [Registration Captcha]
 *     summary: 获取注册图形验证码
 *     description: 生成一个数学表达式图形验证码，返回 captchaKey 和 base64 图片数据。有效期 5 分钟。
 *     responses:
 *       200:
 *         description: 验证码图片及标识
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 captchaKey:
 *                   type: string
 *                   description: 验证码唯一标识，用于后续校验
 *                 captchaImage:
 *                   type: string
 *                   description: base64 编码的 SVG 图片，可直接嵌入 `<img src="data:image/svg+xml;base64,...">`
 *                 expiresIn:
 *                   type: integer
 *                   description: 有效期（秒），默认 300 秒（5 分钟）
 *       500:
 *         description: 验证码生成失败
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiError'
 */
router.get('/captcha/generate', (_req, res) => {
  try {
    const captcha = svgCaptcha.createMathExpr({
      mathMin: 1,
      mathMax: 20,
      mathOperator: '+-',
      noise: 2,
      color: false,
      background: '#cecece',
    });

    const captchaKey = crypto.randomUUID();

    setCaptcha(captchaKey, captcha.text);

    res.json({
      captchaKey,
      captchaImage: Buffer.from(captcha.data).toString('base64'),
      expiresIn: 300,
    });
  } catch (err) {
    console.error('验证码生成失败:', err.message);
    res.status(500).json({ error: '验证码生成失败，请重试' });
  }
});

/**
 * @swagger
 * /api/auth/captcha/verify:
 *   post:
 *     tags: [Registration Captcha]
 *     summary: 验证图形验证码并获取注册令牌
 *     description: 校验用户输入的验证码答案。验证通过后返回一个一次性 regToken，有效期 15 分钟，仅供注册接口使用。
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [captchaKey, answer]
 *             properties:
 *               captchaKey:
 *                 type: string
 *                 description: 从 /generate 接口获取的验证码标识
 *               answer:
 *                 type: string
 *                 description: 用户输入的验证码答案
 *     responses:
 *       200:
 *         description: 验证成功，返回注册令牌
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 regToken:
 *                   type: string
 *                   description: 一次性注册令牌，用于 /auth/register 接口
 *                 expiresIn:
 *                   type: integer
 *                   description: 有效期（秒），默认 900 秒（15 分钟）
 *       400:
 *         description: 验证码错误或已过期
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiError'
 */
router.post('/captcha/verify', (req, res) => {
  const { captchaKey, answer } = req.body || {};

  if (!captchaKey || !answer) {
    return res.status(400).json({ error: '缺少验证码标识或答案' });
  }

  const entry = getCaptcha(captchaKey);
  if (!entry) {
    return res.status(400).json({ error: '验证码已过期或不存在，请刷新重试' });
  }

  if (entry.answer !== String(answer).trim()) {
    return res.status(400).json({ error: '验证码错误，请重新输入' });
  }

  deleteCaptcha(captchaKey);

  const jti = crypto.randomUUID();
  setRegToken(jti);

  const regToken = jwt.sign({ jti, purpose: 'registration' }, CAPTCHA_JWT_SECRET, { expiresIn: '15m' });

  res.json({
    regToken,
    expiresIn: 900,
  });
});

export default router;
