# ReadDeck Server

可自行部署的漫画与小说书库，包含完整的 Node.js 服务端、网页阅读与管理界面，以及 Docker 构建配置。可以通过浏览器独立使用，也可连接兼容的 ReadDeck 客户端。

本仓库仅发布服务端与网页源码，不包含 iOS App 源码、书籍、个人数据或 API Key。项目代码采用 [MIT 许可证](LICENSE)，第三方组件遵循各自许可，见 [第三方声明](THIRD_PARTY_NOTICES.md)。

## 功能

- 扫描和管理图片目录、ZIP / CBZ / RAR / CBR 漫画压缩包、PDF 与 EPUB。
- 网页书库、搜索、漫画与小说阅读、元数据编辑、封面管理和阅读进度。
- 多用户账号、书库访问控制、下载和客户端接口。
- 自动发现书库来源、文件变化监听、扫描任务与元数据任务管理。
- 可选 Bangumi、DeepSeek 和 OpenAI 兼容接口，用于元数据匹配与补充；基本阅读不需要 AI 服务。

## 使用 Docker 镜像部署

需要 Docker 与 Docker Compose v2。当前镜像为 [`evlst/readdeck`](https://hub.docker.com/r/evlst/readdeck)，提供 `linux/amd64` 和 `linux/arm64` 架构。

```sh
git clone https://github.com/everlst/readdeck-server.git
cd readdeck-server
mkdir -p library/comics library/novels data
docker compose pull
docker compose up -d
```

将书籍放入 `library/comics` 或 `library/novels`，访问 `http://服务器地址:13090`。首次以 `admin / admin` 登录，按提示修改密码。然后在服务器设置中确认来源并启动扫描。

来源使用**容器内的子目录**，例如 `/app/library/comics` 或 `/app/library/novels`，不要把挂载根目录 `/app/library` 本身设为来源。业务设置与 API Key 在网页服务器设置中填写，无需把凭据写进 Compose 文件。

如果已有 NAS 书库，修改 `docker-compose.yml` 中挂载左侧的宿主机路径：

```yaml
volumes:
  - /你的书库:/app/library
  - /你的应用数据/readdeck:/app/data
```

书库与数据目录需要可写。网页中的编辑、上传和删除操作会作用于挂载的内容。网络文件系统如不能可靠接收文件变化事件，可在扫描设置中启用轮询。

## 从本仓库源码构建

在仓库根目录运行：

```sh
mkdir -p library/comics library/novels data
docker compose -f docker-compose.yml -f compose.build.yml up -d --build
```

此命令构建本地镜像 `readdeck-server:local`，然后使用与镜像部署相同的端口和数据目录。后续管理该部署时，也应带上这两个 `-f` 参数。

也可以只构建镜像：

```sh
docker build -t readdeck-server:local .
```

构建会安装 Node.js 依赖、libarchive 和 Poppler；不需要 iOS 项目、Xcode 或其他仓库文件。`data`、`library`、`node_modules`、环境文件与本机配置不会复制到镜像。

## 更新、备份与账号恢复

使用发布镜像的部署可执行：

```sh
docker compose pull
docker compose up -d
docker compose logs --tail=100
```

`data` 保存设置、账号、API Key、元数据、阅读进度、任务与缓存；`library` 保存书籍。迁移时停止服务并完整备份这两个挂载目录。`data/cache` 可以重建；`data/config` 包含敏感设置，应限制访问并加密备份。`docker compose down` 不会删除这两个宿主机目录。

忘记管理员密码时运行：

```sh
docker compose exec readdeck node scripts/reset-admin.js
```

该操作恢复初始管理员 `admin / admin` 并撤销旧会话；再次登录后必须修改密码。

## 网络与外部服务

局域网客户端连接 `http://服务器地址:13090`。公网访问请通过具有可信证书的 HTTPS 反向代理。代理需转发 `Authorization`、Range 和 ETag，并为 `/api/events` 保留长连接、禁用响应缓冲。

可选元数据功能会连接相应服务，使用自己的账号和 API Key，费用由所配置的服务提供方决定。网页部分字体来自 Google Fonts 和 jsDelivr；这些字体的加载需要网络。epub.js、JSZip 和楷体标点子集已随源码提供。

## 开发与测试

推荐使用 Dockerfile 中相同的 Node.js 22。非 Docker 开发环境还需安装 libarchive（`bsdtar`）和 Poppler（`pdftoppm`、`pdfinfo`）。

```sh
npm ci
npm start
```

直接运行时默认监听 `13000`，应用数据写入当前项目的 `data`，书库根目录为 `library`。

不安装本机 Node.js 也可以在构建好的镜像内运行回归测试：

```sh
docker build -t readdeck-server:local .
docker run --rm readdeck-server:local npm test
```

安装本机依赖后，可进一步验证 Docker 启动、扫描、账号登录和重启后的数据持久化：

```sh
npm ci
npm run test:docker
```

`npm test` 使用测试夹具，不要求真实 AI Key 或个人书库。另有 `npm run smoke`，需要自行准备对应资源示例并设置 `READER_PLUS_SAMPLE_DIR`；这些资源不随开源仓库分发。

首次独立发布的依赖审计存在待处理告警，具体组件、风险级别和公告见 [依赖检查记录](docs/dependency-status.md)。

## 反馈与贡献

欢迎通过 [Issues](https://github.com/everlst/readdeck-server/issues) 反馈问题，或提交 Pull Request。报告问题时请提供版本、部署方式、复现步骤与脱敏日志，不要附上 API Key、账号密码、完整 `data` 目录或无权分发的书籍。

## 来源与许可证

本项目署名为 **evstk**，采用 MIT 许可证。服务端、网页及部分测试源自 `reader-plus`，其上游版权声明保留在许可证中。本独立仓库基于 ReadDeck 服务端 `2.1.8.2` 建立，使用新的 Git 历史。详细来源和随附组件许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
