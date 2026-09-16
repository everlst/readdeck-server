# 部署与备份

## Docker

根目录 `docker-compose.yml` 使用 Docker Hub 镜像 `evlst/readdeck:latest`，支持 `linux/amd64` 与 `linux/arm64`。执行 `docker compose pull` 后运行 `docker compose up -d` 即可部署；如需固定版本，可将镜像标签改为 `2.1.8.2`。默认映射 `13090:13000`。可根据 NAS 目录修改挂载左侧路径，容器内保持 `/app/library`、`/app/data`。

```yaml
volumes:
  - /你的书库:/app/library
  - /你的应用数据/readdeck:/app/data
```

书库来源需选择挂载内的子目录，如 `/app/library/comics`；禁止系统目录、重叠来源、逃逸符号链接等路径。文件变动监听适合本地磁盘；网络挂载如无法收到变更事件，可在扫描设置中启用轮询。

服务端镜像包含 libarchive 和 Poppler，负责 ZIP/CBZ/RAR 解包以及 PDF 渲染。图片目录、漫画压缩包、PDF 和 EPUB 均由统一扫描器处理。第一次确认来源后，手动扫描；元数据服务的 API Key 可留空，阅读不依赖外部刮削服务。

```sh
docker compose logs --tail=100
docker compose restart
docker compose down
```

`down` 不会删除 bind mount 的书库与持久化数据。更新服务时依次运行 `docker compose pull` 和 `docker compose up -d`。

## 初始化与账号恢复

新安装默认 `admin / admin`，首次登录只能验证账号、修改密码，完成后才能访问书库。密码至少 8 字符。其他用户的初始密码或管理员重置后的密码同样要求修改。

忘记所有管理员密码时，在容器中执行：

```sh
docker compose exec readdeck node scripts/reset-admin.js
```

这会重新启用初始管理员并重置为 `admin / admin`、撤销旧会话。执行后立即登录改密。不会删除书籍、读者或个人进度。服务端保护最后一个有效管理员，避免在界面中禁用全部管理员。

## 网络

同一局域网内 App 填写 `http://NAS地址:13090`。模拟器里的 `127.0.0.1` 指向开发 Mac；真机里的该地址指向手机本身。

跨网络访问建议使用可信证书的 HTTPS 反向代理。代理需转发 `Authorization`、Range、ETag，并为 `/api/events` 禁用响应缓冲且允许长连接。不要把 API 响应放进公共 CDN 缓存；资源会要求重新验证身份和权限。自签名证书必须先由设备信任，不会绕过 TLS 验证。

## 数据与容量

`data/config`：业务设置、密钥和账号，限制访问并加密备份。

`data/metadata`、`data/users`：元数据及每用户阅读进度；其他 `data` 子目录包含任务和索引。建议停止容器后整体备份 `data` 和书库，保证一致性。恢复时同时恢复二者；实例 ID 保留，App 可继续识别原服务器。

`data/cache` 可重建。下载包最长保留约 7 天并按容量回收；活跃传输不被容量回收。服务重启时未完成的包任务标记失败，由客户端重试。清理服务器缓存不会删除 App 保留的下载。

## 缓存容量

服务器阅读缓存的新配置默认 150 MB，可设置 64–4096 MB（4 GB）。已有配置保留有效范围内的值；超出范围的旧值在载入时收敛到边界。iOS 的服务器设置支持滑动条和 MB 数字输入，保存后生效。

客户端的离线存储和封面缓存说明见 [ReadDeck App](https://github.com/everlst/ReadDeck/blob/main/docs/deployment.md)。
