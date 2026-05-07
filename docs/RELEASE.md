# Release 发布指南

本项目使用 GitHub Action 自动化创建 Release，操作简单快捷！

## 前置条件

1. 确保你的仓库已经推送到 GitHub
2. 确保你有仓库的写入权限

## 使用方法

### 1. 通过 GitHub Web 界面创建 Release

1. 访问你的 GitHub 仓库页面
2. 点击顶部的 **Actions** 标签页
3. 在左侧选择 **Create Release** 工作流
4. 点击右侧的 **Run workflow** 按钮
5. 输入以下参数：
   - **version**: 版本号，例如 `v1.0.0`、`v2.1.3`
   - **base_tag** (可选): 基础标签，默认为上一个标签
6. 点击 **Run workflow** 开始执行

### 2. Action 执行内容

工作流会自动完成以下操作：

1. ✅ 检出完整的 Git 历史
2. ✅ 设置 Node.js 环境
3. ✅ 运行 `tools/generate-changelog.js` 生成变更日志
4. ✅ 创建 GitHub Release 并自动插入变更日志
5. ✅ 更新 `package.json` 中的版本号
6. ✅ 提交并推送更改到仓库

## 本地测试

在提交代码前，你可以先在本地测试 changelog 生成：

```bash
# 简单测试
node tools/generate-changelog.js

# 指定版本号
node tools/generate-changelog.js --tag v1.0.0

# 从某个标签开始
node tools/generate-changelog.js --base v0.9.0 --tag v1.0.0

# 查看帮助
node tools/generate-changelog.js --help
```

## 变更日志格式

生成的变更日志采用以下格式：

```markdown
## v1.0.0
> v0.9.0 ... HEAD

### 新增 | New

* 新功能 1
* 新功能 2

### 修复 | Fix

* 修复 Bug 1

### 改进 | Improved

* 性能优化
```

## Commit 规范

为了让 changelog 更好地工作，请遵循以下 commit 规范：

### Commitizen 前缀

- `feat:` - 新功能
- `fix:` - Bug 修复
- `refactor:` - 代码重构
- `perf:` - 性能优化
- `docs:` - 文档更新
- `style:` - 代码格式（不会出现在 changelog）
- `build:` - 构建系统（不会出现在 changelog）
- `ci:` - CI 配置（不会出现在 changelog）

### 中文关键词

也可以直接使用中文关键词：

- 新增
- 修复
- 更新
- 改进
- 优化
- 重构
- 文档

### 跳过 Changelog

如果某个提交不需要出现在 changelog 中，在 commit message 中添加 `[skip changelog]`。

## 注意事项

1. 版本号建议使用 `v` 前缀，例如 `v1.0.0`
2. 确保在创建 Release 前已经提交了所有更改
3. Action 会自动创建 Git 标签，不需要手动创建
4. 如果没有找到上一个标签，会使用最近 50 条提交

## 示例

### 创建一个新的 Release

1. 在 GitHub 上进入 Actions → Create Release
2. 输入版本号：`v2.0.0`
3. 点击 Run workflow
4. 等待 Action 完成
5. 完成后可以在 Releases 页面看到新的 Release！
