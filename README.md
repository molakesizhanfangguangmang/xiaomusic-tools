# xiaomusic-tools

给 [xiaomusic](https://github.com/hanxi/xiaomusic)（小爱音箱网页控制面板）加一个「工具区」和几个小工具，另附一个**插件上传接口**，让工具可以直接从网页上传安装。

适用版本：`hanxi/xiaomusic:v0.6.1`。本包只保证这个版本。

---

## 这是什么

xiaomusic 自带的控制面板没有扩展位。本包做两件事：

1. **工具区**：在控制面板主页加一个「工具」入口，进到一个工具列表页，里面挂着若干独立小工具。
2. **上传接口**：给工具区加一个「上传工具」页，选一个 zip 就能把新工具装进去（不必再手动进容器拷文件）。

工具是纯静态页（`html` + `css` + `js`），跟主面板同一套访问方式、同一个端口。

---

## 包含的工具

- **删除歌曲**：从已下载（`download/`）的歌里单选一首，二级确认后永久删除。
- **链接下载音频**：粘贴 B 站视频/分享链接（或其它 yt-dlp 能解析的 URL），抽音轨转 mp3 落到 `download/`。
- **上传工具**：上传插件包（zip）装进工具区。

---

## 安装

跑在**能执行 docker 的宿主机**上（不是容器里）。

```sh
./install.sh                 # 默认容器名 xiaomusic
./install.sh -c myxiaomusic  # 容器名不同时指定
./install.sh --dry-run       # 只看会做什么，不写入
./install.sh --no-patch      # 只装工具区，不打上传接口
```

装完刷新面板主页，会看到「工具」入口。

### 上传接口会改容器里的 .py

打上传接口补丁时，会给容器内 `api/routers/__init__.py` 加两行、并放入 `api/routers/xtools.py`。这个文件是镜像自带的，所以：

- **日常 start / stop / restart**：不受影响，上传接口一直在。
- **容器重建**（`docker rm` + 重新创建）：`__init__.py` 会被打回镜像原版，上传接口消失。**重跑 `./install.sh` 即可恢复**。
- 脚本改动前会把 `__init__.py` 备份到当前目录；改后做语法检查，不通过就不写入。
- 万一服务起不来：SSH 上宿主机，`docker cp <备份> <容器>:/app/xiaomusic/api/routers/__init__.py` 后 `docker restart`，即恢复。

---

## 卸载

```sh
./uninstall.sh                  # 撤掉上传接口补丁（保留工具区和你上传的插件）
./uninstall.sh --no-patch       # 只删主页工具入口，不动接口
./uninstall.sh --remove-static  # 连 static/xiaomusic_tools 一起删（含你上传的插件，不可逆）
```

---

## 插件包格式

一个 zip。最简结构：

```
mytool/
├── manifest.json    必填
├── index.html       入口页
├── tool.js          可选
└── tool.css         可选
```

`manifest.json`：

```json
{
  "id": "mytool",
  "title": "我的工具",
  "icon": "★",
  "desc": "一句话说明",
  "version": "1.0.0",
  "entry": "index.html"
}
```

- `id`：唯一标识，限字母、数字、短横、下划线，≤64 字符。
- `icon`：一个字形字符，不用图片（离线友好）。
- `entry`：入口页文件名，默认 `index.html`。

包内可以有一个顶层目录（如上面的 `mytool/`），上传时会自动剥掉。装好的工具落在容器内
`static/xiaomusic_tools/<id>/`，并自动登记进 `tools.json`，工具列表页随即出现新卡片。

---

## 接口

无鉴权——**能访问到这个端口的人就能调用**。只在局域网内用没问题；若要暴露到公网，请自行在前置代理上做访问控制。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/xtools/upload` | 上传插件包（multipart，字段 `file`，可选 `overwrite=true`） |
| `GET`  | `/api/xtools/list` | 列出已装插件 |
| `POST` | `/api/xtools/uninstall` | 卸载插件（字段 `id`） |

版本不符时（非 0.6.1），接口返回 503 并停用，不影响音乐服务本身。

---

## 目录

```
install.sh / uninstall.sh     安装、卸载
static/xiaomusic_tools/       工具区静态站（含各工具）
patch/xtools.py               上传接口
patch/patch_xtools.sh         打补丁
patch/unpatch_xtools.sh       撤补丁
```

---

## 许可

MIT
