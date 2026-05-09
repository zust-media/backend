## v0.1.0

### 新增 | New

* 实现临时授权码系统并限制签名URL生成 ([cb18117c](https://github.com/zust-media/backend/commit/cb18117c)) @ImJingLan
* 为图片添加公开状态属性 ([46ce637c](https://github.com/zust-media/backend/commit/46ce637c)) @ImJingLan
* 图片处理端点支持format参数选择输出格式 ([1fea5363](https://github.com/zust-media/backend/commit/1fea5363)) @ImJingLan
* 添加批量下载端点 ([f51dceec](https://github.com/zust-media/backend/commit/f51dceec)) @ImJingLan
* 照片夹下载改用压缩图片并支持自定义格式 ([3793fd04](https://github.com/zust-media/backend/commit/3793fd04)) @ImJingLan
* 添加compressForDownload图片压缩工具函数 ([f6cc286d](https://github.com/zust-media/backend/commit/f6cc286d)) @ImJingLan
* 后端实现了照片夹功能 ([923a3123](https://github.com/zust-media/backend/commit/923a3123)) @ImJingLan
* 完善路由系统，集成操作日志与Slug管理 ([c5d66a17](https://github.com/zust-media/backend/commit/c5d66a17)) @ImJingLan
* 实现操作日志系统 ([563e0e53](https://github.com/zust-media/backend/commit/563e0e53)) @ImJingLan
* 实现注册验证码流程 ([39613d2f](https://github.com/zust-media/backend/commit/39613d2f)) @ImJingLan
* 添加关键字黑名单系统 ([34161c17](https://github.com/zust-media/backend/commit/34161c17)) @ImJingLan
* 首次提交 ([547f7a16](https://github.com/zust-media/backend/commit/547f7a16)) @ImJingLan

### 修复 | Fix

* 修复非公开图片在主页和集合页仍可见的问题 ([12f6f2e1](https://github.com/zust-media/backend/commit/12f6f2e1)) @ImJingLan
* 限制照片夹访问权限 ([a321516d](https://github.com/zust-media/backend/commit/a321516d)) @ImJingLan
* 修复打包下载端点参数不完整的问题 ([ce1eb4f6](https://github.com/zust-media/backend/commit/ce1eb4f6)) @ImJingLan
* 修复压缩包打包报错 ([7eaa39b4](https://github.com/zust-media/backend/commit/7eaa39b4)) @ImJingLan
* 修复照片夹端点缺少相关字段 ([3b459bdf](https://github.com/zust-media/backend/commit/3b459bdf)) @ImJingLan

### 文档 | Docs

* 补充批量下载端点和照片夹的API文档 ([174b9394](https://github.com/zust-media/backend/commit/174b9394)) @ImJingLan
* 更新Swagger API文档与项目配置 ([a2899357](https://github.com/zust-media/backend/commit/a2899357)) @ImJingLan

### 自动化 | CI

* 修改快照的标题 ([996606ea](https://github.com/zust-media/backend/commit/996606ea)) @ImJingLan
* 修复 Release 发布时读取到快照 Tag ([8ca65c43](https://github.com/zust-media/backend/commit/8ca65c43)) @ImJingLan
* 修复weekly-snapshot.js冲突和创建首个版本时基础标签为null的问题 ([89cf4e1d](https://github.com/zust-media/backend/commit/89cf4e1d)) @ImJingLan
* CHANGELOG 将输出 CI 改动 ([ade8aaa3](https://github.com/zust-media/backend/commit/ade8aaa3)) @ImJingLan
* 修复了错误 Git 合并导致的脚本错误 ([77f352e3](https://github.com/zust-media/backend/commit/77f352e3)) @ImJingLan
* 添加了 CHANGELOG 分类 ([0589c3c3](https://github.com/zust-media/backend/commit/0589c3c3)) @ImJingLan
* 修复了 CHANGELOG GENERATOR 中贡献者的格式 ([f27e25e2](https://github.com/zust-media/backend/commit/f27e25e2)) @ImJingLan
* 在每条 CHANGELOG 后显示提交者 ([a797eb40](https://github.com/zust-media/backend/commit/a797eb40)) @ImJingLan
* 在 CHANGELOG 中显示贡献者列表 ([203a99a9](https://github.com/zust-media/backend/commit/203a99a9)) @ImJingLan
* 使release脚本更加通用，使用GitHub API获取最新release ([74bec8fc](https://github.com/zust-media/backend/commit/74bec8fc)) @ImJingLan
* 修改正式版本发布的 BaseTag 逻辑，只与正式 RELEASE 比较 ([02431255](https://github.com/zust-media/backend/commit/02431255)) @ImJingLan
* 添加无提交检测，若无新提交则取消发布 ([18a59e2f](https://github.com/zust-media/backend/commit/18a59e2f)) @ImJingLan
* 添加 GitHub Compare 链接 ([18500b36](https://github.com/zust-media/backend/commit/18500b36)) @ImJingLan
* 修复GitHub Action获取周快照基础标签的问题 ([d270d683](https://github.com/zust-media/backend/commit/d270d683)) @ImJingLan
* 添加每周快照发布功能 ([8ac5a27a](https://github.com/zust-media/backend/commit/8ac5a27a)) @ImJingLan
* 添加 GitHub Action 自动化 Release 工作流 ([213cc38a](https://github.com/zust-media/backend/commit/213cc38a)) @ImJingLan
* 修复了CHANGELOG生成器 ([43e63574](https://github.com/zust-media/backend/commit/43e63574)) @ImJingLan

### 其他 | Other

* 更新项目依赖与开发工具 ([e3813745](https://github.com/zust-media/backend/commit/e3813745)) @ImJingLan
