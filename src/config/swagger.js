import swaggerJsdoc from 'swagger-jsdoc';

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'ZustMedia API',
      version: '2.1.0',
      description: 'ZustMedia 图库系统 RESTful API 文档\n\n## 认证说明\n大部分管理类接口需要 JWT Token 认证，在请求头中添加 `Authorization: Bearer <token>`。\n\n## 默认账号\n- 管理员：`admin` / `admin123`\n- 普通用户：`user` / `user123`\n\n## 轻量引用设计\n为减轻传输压力，API 采用"轻量引用"模式：\n- **标签/分类**：所有接口（列表、详情、图片关联）均只传输整数 ID，不再返回 `name`/`slug` 等冗余字段，前端通过共享缓存（`GET /api/tags/list`、`GET /api/categories/list`）查找名称\n- **用户**：所有接口均使用 UUID 引用用户，不再返回 `username`，前端通过 `GET /api/users/:uuid` 获取用户详情\n- **图片的 tags 字段**：返回 `[1, 2, 3]`（整数ID数组），而非嵌套对象\n- **图片的 uploader_uuid 字段**：返回上传者的 UUID 字符串\n\n## Slug 规则\n- **用户个性地址**：仅支持字母、数字、下划线和连字符，**禁止 UUID 格式**（8-4-4-4-12 十六进制），纯数字允许使用\n- **标签/分类 Slug**：仅支持字母数字和连字符，**禁止纯数字**\n- Slug 在各自类型内唯一，重复设置会返回 400 错误指明冲突原因',
    },
    servers: [
      { url: 'http://localhost:8080', description: '本地开发服务器' },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'JWT 认证 Token，通过 /api/auth/login 获取',
        },
      },
      schemas: {
        User: {
          type: 'object',
          properties: {
            id: { type: 'integer', description: '用户ID' },
            uuid: { type: 'string', description: '用户UUID' },
            username: { type: 'string', description: '用户名' },
            nickname: { type: 'string', description: '昵称' },
            role: { type: 'string', enum: ['admin', 'user'], description: '角色' },
            slug: { type: 'string', description: '自定义个性地址（仅字母数字下划线连字符，非UUID格式）' },
            bio: { type: 'string', description: '个人简介' },
            created_at: { type: 'string', format: 'date-time', description: '创建时间' },
          },
        },
        ImageExif: {
          type: 'object',
          properties: {
            make: { type: 'string', description: '相机制造商' },
            model: { type: 'string', description: '相机型号' },
            lens: { type: 'string', description: '镜头型号' },
            focalLength: { type: 'string', description: '焦距' },
            aperture: { type: 'string', description: '光圈值' },
            shutterSpeed: { type: 'string', description: '快门速度' },
            iso: { type: 'string', description: 'ISO感光度' },
            dateTaken: { type: 'string', description: '拍摄日期' },
            flash: { type: 'string', description: '闪光灯状态' },
            exposureCompensation: { type: 'string', description: '曝光补偿' },
            gps: { type: 'string', description: 'GPS坐标' },
            dimensions: { type: 'string', description: '图片尺寸' },
            software: { type: 'string', description: '处理软件' },
            copyright: { type: 'string', description: '版权信息' },
          },
        },
        Image: {
          type: 'object',
          properties: {
            id: { type: 'integer', description: '图片ID' },
            uuid: { type: 'string', description: '图片UUID' },
            uploader_uuid: { type: 'string', description: '上传者用户UUID' },
            filename: { type: 'string', description: '存储文件名' },
            original_name: { type: 'string', description: '原始文件名' },
            mime_type: { type: 'string', description: 'MIME类型' },
            file_size: { type: 'integer', description: '文件大小（字节）' },
            title: { type: 'string', description: '标题' },
            description: { type: 'string', description: '描述' },
            category_id: { type: 'integer', nullable: true, description: '所属分类ID' },
            tags: { type: 'array', items: { type: 'integer' }, description: '标签ID列表' },
            exif: { $ref: '#/components/schemas/ImageExif' },
            thumbnail_url: { type: 'string', description: '缩略图URL' },
            preview_url: { type: 'string', description: '预览图URL' },
            download_url: { type: 'string', description: '下载URL' },
            created_at: { type: 'string', format: 'date-time', description: '上传时间' },
            is_duplicate: { type: 'integer', description: '是否重复文件 (0/1)' },
            duplicate_of: { type: 'integer', nullable: true, description: '重复于图片ID' },
          },
        },
        Tag: {
          type: 'object',
          properties: {
            id: { type: 'integer', description: '标签ID' },
            name: { type: 'string', description: '标签名称' },
            slug: { type: 'string', description: '标签URL标识（仅字母数字和连字符，非纯数字）' },
            image_count: { type: 'integer', description: '关联图片数量' },
          },
        },
        Category: {
          type: 'object',
          properties: {
            id: { type: 'integer', description: '分类ID' },
            name: { type: 'string', description: '分类名称' },
            slug: { type: 'string', description: '分类URL标识（仅字母数字和连字符，非纯数字）' },
            description: { type: 'string', description: '分类描述' },
            image_count: { type: 'integer', description: '图片数量' },
            created_at: { type: 'string', format: 'date-time', description: '创建时间' },
          },
        },
        Gallery: {
          type: 'object',
          properties: {
            id: { type: 'integer', description: '照片夹ID' },
            uuid: { type: 'string', description: '照片夹UUID' },
            name: { type: 'string', description: '照片夹名称' },
            description: { type: 'string', description: '照片夹描述' },
            creator_uuid: { type: 'string', description: '创建者UUID' },
            is_public: { type: 'integer', description: '是否公开 (0/1)' },
            image_count: { type: 'integer', description: '图片数量' },
            created_at: { type: 'string', format: 'date-time', description: '创建时间' },
            updated_at: { type: 'string', format: 'date-time', description: '更新时间' },
          },
        },
        Pagination: {
          type: 'object',
          properties: {
            page: { type: 'integer', description: '当前页码' },
            limit: { type: 'integer', description: '每页数量' },
            total: { type: 'integer', description: '总记录数' },
            total_pages: { type: 'integer', description: '总页数' },
          },
        },
        ApiError: {
          type: 'object',
          properties: {
            error: { type: 'string', description: '错误信息' },
          },
        },
        ApiMessage: {
          type: 'object',
          properties: {
            message: { type: 'string', description: '操作结果消息' },
          },
        },
      },
    },
    paths: {
      '/api/img/{filename}': {
        get: {
          tags: ['Images'],
          summary: '图片服务端点（缩略图/预览/下载）',
          description: '根据参数返回处理后的图片。需要签名验证。支持缩放(`w`)、质量(`q`)、水印(`m`)和下载模式(`dl`)。',
          parameters: [
            { in: 'path', name: 'filename', required: true, schema: { type: 'string' }, description: '图片存储文件名' },
            { in: 'query', name: 'w', schema: { type: 'integer' }, description: '图片宽度（像素）' },
            { in: 'query', name: 'q', schema: { type: 'integer' }, description: '图片质量（1-100）' },
            { in: 'query', name: 'm', schema: { type: 'string' }, description: '水印模式' },
            { in: 'query', name: 'dl', schema: { type: 'string' }, description: '设为 1 触发下载' },
            { in: 'query', name: 'sig', required: true, schema: { type: 'string' }, description: 'URL 签名' },
            { in: 'query', name: 'exp', schema: { type: 'integer' }, description: '签名过期时间戳' },
          ],
          responses: {
            '200': { description: '图片二进制数据', content: { 'image/jpeg': {}, 'image/png': {} } },
            '404': { description: '图片不存在或处理失败', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
            '500': { description: '图片处理失败', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          },
        },
      },
      '/api/users/lookup': {
        get: {
          tags: ['Users'],
          summary: '批量查找用户（公开）',
          description: '通过逗号分隔的UUID列表批量查询用户信息，返回 username、nickname、slug',
          parameters: [
            { in: 'query', name: 'uuids', required: true, schema: { type: 'string' }, description: '逗号分隔的UUID列表' },
          ],
          responses: {
            200: {
              description: '用户信息映射',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      users: {
                        type: 'object',
                        additionalProperties: {
                          type: 'object',
                          properties: {
                            uuid: { type: 'string' },
                            username: { type: 'string' },
                            nickname: { type: 'string' },
                            slug: { type: 'string' },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
  apis: ['./src/routes/*.js'],
};

const swaggerSpec = swaggerJsdoc(options);

export default swaggerSpec;
