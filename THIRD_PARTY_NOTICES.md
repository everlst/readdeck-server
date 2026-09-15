# 来源与第三方声明

## 项目代码

本仓库发布 ReadDeck 的服务端、网页客户端与回归测试，首次独立发布基于服务端版本 `2.1.8.2`。不包含原项目的 iOS 代码、提交历史、运行数据、凭据或个人书库。

服务端、网页及部分测试的上游为 `reader-plus`，原提取基线为提交 `3ae125725a9183cfd1f2b665384fa9255d61138d`，之后包含 ReadDeck 的功能扩展与修复。原作者 hhhhhhsx 的 MIT 版权和许可声明保留于 [LICENSE](LICENSE)。

独立发布新增部署文档、Compose 配置、忽略规则以及 Docker 镜像的来源和许可声明。未更改原作者声明。

## 随源码提供的网页组件

| 组件 | 版本 / 来源 | 许可与随附文件 |
| --- | --- | --- |
| epub.js | 0.3.93，[futurepress/epub.js](https://github.com/futurepress/epub.js) | BSD-2-Clause；[EPUBJS-LICENSE.txt](public/vendor/EPUBJS-LICENSE.txt) |
| JSZip | 3.10.1，[Stuk/jszip](https://github.com/Stuk/jszip) | MIT / GPLv3 双许可，本项目选择 MIT；[JSZIP-LICENSE.txt](public/vendor/JSZIP-LICENSE.txt) |
| Reader Plus Kai Punctuation | 基于 AR PL UKai CN 0.2.20080216 的三个标点字形 | ARPHIC PUBLIC LICENSE；[ARPHICPL.txt](public/fonts/ARPHICPL.txt) |

标点字体由 Reader Plus 在 2026-09-06 修改并重命名，修改与原始来源说明见 [public/fonts/README.md](public/fonts/README.md)。原作者为 Arphic Technology Co., Ltd.（1994–1999）及 Arne Goetje（2003–2007）。本仓库保留字体修改说明与许可。

## 运行时加载的字体

网页会从 Google Fonts 加载 Noto Serif SC、Noto Sans SC、ZCOOL KuaiLe，从 jsDelivr 加载霞鹜文楷网页字体与完整 AR PL UKai CN。这些完整字体不随本仓库分发。前三类 Google Fonts 字体及霞鹜文楷遵循 SIL Open Font License；AR PL UKai CN 遵循 ARPHIC PUBLIC LICENSE。离线环境下外部字体可能无法加载。

## Node.js 依赖与容器系统组件

Node.js 依赖版本及其许可元数据记录于 [package-lock.json](package-lock.json)；依赖安装后保留各包自带的版权和许可文件。项目 MIT 许可证不替代这些组件的许可证。

Dockerfile 基于官方 `node:22-alpine`，并通过 Alpine 包管理器安装 libarchive 与 Poppler：

- [Node.js](https://github.com/nodejs/node)：MIT 及其自带依赖的许可声明。
- [Alpine Linux](https://alpinelinux.org/)：各系统包按各自许可证分发。
- [libarchive](https://github.com/libarchive/libarchive)：BSD 系列许可及所用组件许可。
- [Poppler](https://poppler.freedesktop.org/)：GPL 系列许可，具体条款以安装版本和组件为准。

这些是容器内的独立组件，不以本项目 MIT 许可证重新授权。重新分发镜像时应同时遵守各组件的声明及适用的源码提供要求；本文件不替代上游完整许可证。Alpine 的包版本、构建配方与源码获取地址可通过 [Alpine 软件包索引](https://pkgs.alpinelinux.org/packages) 查询。
