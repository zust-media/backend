# 迁移指南

## 🚨 破坏性更改：超级管理员角色变更为 `super_admin`

**影响版本**：`>= 1.2.0`

### 变更概述

| 项目 | 变更前 | 变更后 |
|------|--------|--------|
| 超级管理员角色 | `role = 'admin'`，靠 `id = 1` 保护不可删除 | `role = 'super_admin'`，靠角色字段保护不可删除 |
| register 返回 | 首个用户 `role = 'admin'` | 首个用户 `role = 'super_admin'` |
| 删除保护 | `if (user.id === 1)` | `if (user.role === 'super_admin')` |
| 权限中间件 | 仅识别 `role === 'admin'` | 同时识别 `admin` 和 `super_admin` |
| 登录页 | 展示演示账号 admin/admin123 | 已移除演示账号 |
| 站点初始化 | 需手动访问 /register | 如无超级管理员，自动跳转注册页 |

### 对现有系统的影响

- **已有 `admin` 角色的管理员**：权限不受影响，`requireAdmin` 中间件同时接受 `admin` 和 `super_admin`
- **首位注册用户**：现在获得 `super_admin` 而非 `admin` 角色
- **超级管理员保护**：从 ID 判断改为角色字段判断，更安全可靠

### 迁移步骤（已有系统）

如果已有系统中存在 id=1 的超级管理员（role='admin'），可手动更新其角色：

```sql
UPDATE users SET role = 'super_admin' WHERE id = 1;
```

---

## 🚨 破坏性更改：API 路径统一使用 UUID（用户与图片）

**影响版本**：`>= 1.1.0`

### 变更概述

| 接口 | 变更前 | 变更后 |
|------|--------|--------|
| `DELETE /api/users/{id}` | 通过用户整数ID删除 | 通过用户UUID删除 |
| `PUT /api/users/{id}` | 通过用户整数ID更新 | 通过用户UUID更新 |
| `GET /api/images/detail/{id}` | 通过图片整数ID获取详情 | 通过图片UUID获取详情 |
| `PUT /api/images/detail/{id}` | 通过图片整数ID更新 | 通过图片UUID更新 |
| `DELETE /api/images/delete/{id}` | 通过图片整数ID删除 | 通过图片UUID删除 |
| `POST /api/images/batch-delete` | body 传 `{ ids: [1,2,3] }` | body 传 `{ image_uuids: ["uuid1","uuid2"] }` |
| `POST /api/images/batch-update` | body 传 `{ ids: [1,2,3], ... }` | body 传 `{ image_uuids: ["uuid1","uuid2"], ... }` |
| `GET /api/images/batch-info` | query 传 `?ids=1,2,3` | query 传 `?uuids=uuid1,uuid2` |
| `POST /api/auth/register` | 首个用户免 regToken | 所有用户均需 regToken |

### 兼容性说明

图片接口支持 UUID 降级查找：如果传入的是旧版整数ID，后端会自动通过 ID 查找对应图片。建议前端尽快切换到 UUID。

### 依赖升级

使用这些接口的客户端/脚本需要将原有的整数 ID 参数替换为 UUID。可以通过 `formatImage().uuid` 或 `formatUser().uuid` 获取对应的 UUID 字段。

---

## 🚨 破坏性更改：移除默认管理员账户，首个注册用户自动成为超级管理员

**影响版本**：`>= 1.0.0`（commit `93c1627` 及之后）

### 变更概述

| 项目 | 变更前 | 变更后 |
|------|--------|--------|
| 默认账户 | 数据库初始化时自动创建 `admin/admin123` 和 `user/user123` | 不再自动创建任何账户 |
| 首次注册 | 需要先获取图形验证码 + regToken | 需验证码，注册后自动成为超级管理员（`role='admin'`、`id=1`） |
| 后续注册 | 需要图形验证码 + regToken | 不变 |
| 超级管理员删除 | 所有 `role='admin'` 的用户均不可删除 | 仅 `id=1` 的超级管理员不可删除，其他管理员可正常删除 |

### 对现有系统的影响

- **已有用户的系统**：完全透明，已存在的 `admin` 和普通管理员账户不受影响，继续正常工作。
- **全新部署**：数据库初始化后没有任何用户，需要手动注册第一个账户作为超级管理员。

### 迁移步骤（全新部署）

1. 启动服务器
2. 通过 `POST /api/auth/captcha/generate` 获取验证码
3. 通过 `POST /api/auth/captcha/verify` 验证后获取 regToken
4. 调用 `POST /api/auth/register` 传入 regToken：
   ```json
   {
     "username": "your_admin",
     "password": "your_password",
     "regToken": "验证后获取的token"
   }
   ```
5. 返回 `{ "message": "超级管理员注册成功", "role": "admin" }`
6. 使用该账户登录即可管理整个系统

### 需要更新的集成

如果您的自动化脚本或 CI/CD 依赖 `admin/admin123` 默认账户进行 API 测试：

1. 启动服务器后先通过验证码流程获取 regToken
2. 调用注册接口创建管理员
3. 使用注册的管理员账户进行后续测试
