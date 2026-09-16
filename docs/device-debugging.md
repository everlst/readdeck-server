# App 联调服务

此仓库维护调试服务、测试夹具和运行数据；iOS 的构建与 XCTest 编排在 [ReadDeck App](https://github.com/everlst/ReadDeck) 仓库维护。

## 真实资源服务

在本仓库根目录运行：

```sh
npm ci
node scripts/start-device-server.mjs /绝对路径/资源示例
```

脚本复制样例至 `build/device-debug/library`，不会直接修改原始资源。默认监听 `13090`；独立设置位于 `build/device-debug/server-data`，随机管理员账号保存在权限为 600 的 `build/device-debug/account.json`。后续启动可省略示例目录。默认关闭启动扫描与自动刮削，需在客户端明确启动扫描。

`READDECK_DEVICE_RUNTIME` 可指定其他运行目录的绝对路径；App 的 `scripts/test-device.mjs` 也须使用同一值才能读取账号。App 通过 `READDECK_SERVER_ROOT` 找到本仓库，默认使用相邻的 `../readdeck-server`。App 测试结果仍保存在 App 仓库内。

可在服务器设置中配置元数据服务，或用 `READDECK_DEVICE_KEY_FILE` 指向本机私密 JSON 文件 `{ "deepseekApiKey": "你的密钥" }`。禁止把该文件、运行账号、书籍、API Key、日志或数据目录提交 Git。

## 合成测试夹具

```sh
npm run fixture
npm run fixture:transfers
node scripts/detail-ui-fixture.js
```

以上为分别运行的测试服务，默认端口分别为 15931、15933/15934、15947。它们使用临时书库和合成账号，供 App 集成验收；不要部署到公网。App 模拟器脚本为每个配置启动隔离实例并在测试后关闭。

## 本机旧运行目录迁移

仓库拆分时，原 App 的服务端依赖保存在本仓库忽略的 `build/migration-backup` 下，原 `build/device-debug` 中的书库、服务端数据和账号迁至本仓库同名目录；iOS 测试产物留在 App。迁移不改变书籍内容、账号、资源 ID 或实例 ID。运行配置中的旧绝对路径调整为新位置，修改前副本保留于同一迁移备份目录。
