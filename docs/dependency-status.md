# 依赖检查记录

检查日期：2026-09-15。对象：首次独立发布所用的 `package-lock.json`（应用版本 `2.1.8.2`）。

`npm audit` 报告 4 个存在安全公告的依赖包：2 个高风险、1 个中风险、1 个低风险。该结果是依赖版本与公告的匹配，不等于已验证 ReadDeck 中存在可利用的攻击路径。

| 依赖 | 风险级别 | 公告 |
| --- | --- | --- |
| sharp | 高 | [libvips](https://github.com/advisories/GHSA-f88m-g3jw-g9cj)、[libheif](https://github.com/advisories/GHSA-rgj7-g3m4-5g8c) |
| path-to-regexp | 高 | [路由正则拒绝服务](https://github.com/advisories/GHSA-37ch-88jc-xwx2) |
| qs | 中 | [序列化异常](https://github.com/advisories/GHSA-q8mj-m7cp-5q26)、[数组限制](https://github.com/advisories/GHSA-x5fp-wj9c-mxmx)、[拒绝服务](https://github.com/advisories/GHSA-4mjr-xmp4-gh2g) |
| body-parser | 低 | [无效 limit 参数](https://github.com/advisories/GHSA-v422-hmwv-36x6) |

后续维护应更新这些依赖并验证图片解码、上传、路由及请求参数处理。审计工具建议 sharp 升级至 `0.35.4`，需要修改当前版本约束并检查兼容性。

安装时 npm 另对 Multer 1.x 显示弃用与安全提醒，建议迁移至 2.x；这条安装提醒与上述 4 项审计结果分开记录。

公告和修复版本可能变化，维护时应重新运行 `npm audit`。依赖审计、功能回归与 Docker 运行检查回答不同问题，功能测试通过不代表不存在依赖漏洞。
