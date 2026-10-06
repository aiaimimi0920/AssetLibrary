# P1：私有资源目录与读取授权

## 范围与运行边界

P1 使用单个 TypeScript Worker 和原生 D1 binding。没有通用 ORM、第三方适配器、账号表、R2 调用、公开目录、发布或下载接口。所有新资源都是私有 `draft`；拥有目录读取权限不等于取得包体或安装资格。

`src/index.ts` 负责 HTTP 错误边界，`identity.ts` 验证外部身份，`resources/routes.ts` 校验输入，`queries.ts` 和 `mutations.ts` 集中持有 D1 SQL。当前数据库查询直接使用 `env.DB`，不启用复制会话或授权缓存。

## 身份合同

必须由部署者配置 `AUTH_ISSUER`、`AUTH_AUDIENCE`，以及恰好一种固定公钥输入：单个 `AUTH_PUBLIC_JWK`，或 `.19` 新增的 `AUTH_PUBLIC_JWKS`（1–4 把 RSA 公钥的静态 JSON，不是 URL）。请求携带 `Authorization: Bearer <JWT>`；只允许 RS256，验证签名、issuer、audience、`sub`、`iat`、`exp` 和可选 `nbf`。令牌有效期不得超过 15 分钟，未设置时间宽限。JWKS 必须精确命中唯一 `kid`；输入边界和单钥迁移窗口见 [P6 公钥轮换合同](P6_IDENTITY_ROTATION.md)。

`sub` 是独立账号系统提供的不透明 `PrincipalRef`，当前接受 1–200 个 ASCII 字母、数字或 `:._@-`。不解释其内部结构，不查询历史账号库。拥有者可以向已知引用授予目录读取权限；P1 不验证该外部主体是否仍然存在，这属于真实账号接入验收。

不接受 `X-Principal-Ref`、客户端 owner、角色、JWKS URL 或无签名开发令牌，不根据令牌 `jku`/嵌入 `jwk` 联网或选择新密钥。缺少/错误公钥配置返回 503；无效身份返回 401。测试在内存中生成短期测试签名者，不写入真实凭据，也没有部署可用的测试认证旁路。`.19` 已实现固定公钥轮换和本地配置恢复；真实外部签发方接入及 Cloudflare 轮换仍留待 P6 单独验收。

## API

所有业务响应都设置 `Cache-Control: no-store` 和 `X-Content-Type-Options: nosniff`。无权读取与资源不存在统一返回 404。没有跨域 cookie 身份或默认开放 CORS。

`.20` 的所有主 Worker HTTP 响应另有服务端生成的 `X-Request-ID` 与固定脱敏响应事件；不接受客户端请求 ID，不记录 JWT/主体/路径/query/body。事件只表示响应已构造，不代表流传输成功。运行合同见 [P6 观测与恢复](P6_OPERATIONS_RECOVERY.md)。

| 方法与路径 | 输入 | 权限与返回 |
| --- | --- | --- |
| `GET /healthz` | 无 | 无需身份，仅表示 Worker 存活，不表示 DB/身份就绪 |
| `GET /readyz` | 无 | `.20` 新增，无需身份；固定身份公钥/15 表存在性/R2 HEAD 只读探测，全可用 200，否则脱敏 503；不探测 scanner，不表示生产分发准入 |
| `POST /v1/resources` | `{"kind":"art","title":"示例"}` | 当前主体成为 owner；201 |
| `GET /v1/resources/{id}` | 无 | owner 或读成员；200 |
| `PATCH /v1/resources/{id}` | `{"title":"新标题","revision":1}` | 仅 owner；200 |
| `DELETE /v1/resources/{id}` | `{"revision":2}` | 仅 owner；墓碑删除并解除所有读成员；200 |
| `PUT /v1/resources/{id}/members/{PrincipalRef}` | `{"revision":3}` | 仅 owner；授予目录读取；200 |
| `DELETE /v1/resources/{id}/members/{PrincipalRef}` | `{"revision":4}` | 仅 owner；解除目录读取；200 |
| `GET /v1/me/resources?limit=20&after={id}` | 可选分页参数 | 当前主体拥有或有权读取的活动资源 |

`kind` 仅允许 `art`、`capability`、`application`。标题去首尾空白、限制 200 字符并拒绝控制字符。JSON 读取按实际流量限制 8192 字节，不只信任 Content-Length；拒绝未知字段。所有 SQL 值均使用参数绑定。

详情和写入结果形状：

```json
{
  "id": "UUID v4",
  "owner": "user:alice",
  "kind": "art",
  "title": "示例",
  "state": "draft",
  "revision": 1,
  "createdAt": "ISO 8601",
  "updatedAt": "ISO 8601"
}
```

列表返回 `{"items":[...],"nextCursor":null}`，每页 1–50 项，以 UUID 按字典序稳定排序，不承诺创建时间顺序。owner 与成员两条索引查询合并去重；私有详情和列表使用同一授权事实。并发修改时分页不是历史快照。

每次成功的修改、成员授予/解除及删除都增加资源 revision。不同幂等键的重复成员操作仍表示新的成功变更意图并增加 revision；相同键的重放不会增加。墓碑不可读取、编辑、授权或复活。没有物理清空数据库的业务 API。

## 原子性、幂等与竞争

所有写操作必须携带 `Idempotency-Key`：8–128 个 ASCII 字母、数字或 `._:-`。作用域为已验证主体，摘要包含规范化后的操作、资源、revision 及业务输入；字段顺序和标题首尾空白不造成无意义冲突。

一个 D1 `batch()` 完成以下步骤：

1. 以 `(principal, request_key)` 唯一键声明请求，并在同一事务内判断 owner、活动状态和 revision。
2. 只有当前服务端生成的 `operation_id` 且状态成功时，才执行业务和成员修改。
3. 保存不可变的 HTTP 状态和结果，并且仅为实际成功写入增加一条审计事件。
4. 返回已保存结果。重放没有本次 `operation_id`，因此不会再次写业务或审计。

条件失败显式返回 404/409，不伪装成 SQL 异常；不会由于“UPDATE 零行仍然成功”而写出幽灵审计。相同主体和键、不同内容返回 `409 IDEMPOTENCY_CONFLICT`。相同内容返回首次结果，即使资源后来改变；客户端需要最新状态时再 GET。过期 revision 返回 `409 REVISION_CONFLICT`，客户端刷新后使用新键重试。

SQL/驱动失败使整个批次回滚，返回脱敏 `503 SERVICE_UNAVAILABLE`，不记录 JWT、SQL 参数或内部异常。客户端可以用原键重试；服务端不擅自重复业务副作用。测试在审计 INSERT 处注入真实 SQLite ABORT，证明已经执行的资源更新和幂等键一起回滚。

当前幂等记录、墓碑和审计保留在 D1，没有后台清理或配额系统。上线前需按真实使用量制定保留和限流规则，不能把本地小负载验证当成长期容量证明。

## 数据模型

`db/0001_catalog.sql` 是空库建表脚本，通过 Wrangler migrations 管理重复应用，不继承旧 PostgreSQL 数据或迁移脚本。表为 `resources`、`resource_members`、`mutation_requests` 和 `audit_events`；使用 STRICT、主键、外键、CHECK、owner/成员分页索引。

删除墓碑保留审计关联；成员只能由 owner 的原子事务管理。没有当前业务需要的发布者团队、版本、包体和审核表，不预建空壳。

## 当前验证与外部资料

本地使用 Wrangler 构建的同一 Worker bundle，由 Miniflare/workerd 执行 HTTP 和真实 D1 SQLite binding；不是内存 Map 数据库 mock。它不证明 Cloudflare 远程部署、真实账号、R2 或分发链路通过。

2026-10-04 联网核实官方 [D1 batch 文档](https://developers.cloudflare.com/d1/worker-api/d1-database/) 的事务和回滚语义；实际平台行为仍以授权后的 P6 为准。
