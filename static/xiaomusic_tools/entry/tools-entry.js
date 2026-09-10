/* tools-entry.js —— xiaomusic default 主控制面板「工具」入口注入器
 *
 * 定位 / 用法（US-004，doc_frontend §2.2-B 最小做法）：
 *   本文件 = “注入器”。它唯一的任务：在 default 主控制面板(default/index.html)里，
 *   「添加工具 / device 按钮行(.mode-controls)」的末尾再 append 一个“工具”图标入口，
 *   点它则根绝对跳转到工具一层页固定地址：/static/xiaomusic_tools/index.html
 *   (xiaomusic StaticFiles 不自动列目录/不回退 index，裸目录 /static/xiaomusic_tools/ 实测 404)。
 *   不要把工具/跳转逻辑写死进注册表(tools.json 是纯数据)；真实二级页列表由一层页读
 *   registry tools.json 决定（本注入器只需知道 landing 的固定根绝对地址）。
 *
 *   部署时不用改动原本 344 行主页任何「正文」，只需在主页文件最末尾、</body> 前追加
 *   唯一一行 script 引用（README「主页入口」章节给原样行）：
 *     <script src="/static/xiaomusic_tools/entry/tools-entry.js"></script>
 *   每次加载主页即出现「工具」入口；回滚=删掉该行（+ 如需整链路清空，再删掉
 *   /static/xiaomusic_tools 整个目录，见 README 回滚小节）。
 *
 * 最小作用域约定（验收 5）：本文件不定义任何全局；不改、不覆盖 md.js 的任何函数；
 *   只在“自己的唯一目标节点”上挂一个 click 监听，不向 .mode-controls 或其父容器
 *   委托/转发事件，也不触碰 md.js 的弹窗(component-overlay/closeAllDialogs 等管理区)。
 *   md.js 对 .icon-item 的禁用只匹配 <p> 本文为 搜索/定时/测试 三项（web_device 模式），
 *   “工具”不在名单，天然不受其禁用逻辑影响。
 */
(function () {
  'use strict';

  /* 工具一层页固定地址：xiaomusic 的 StaticFiles 挂载不会自动列目录/自动回退 index(实测
     /static/xiaomusic_tools/ 与 /static/default/ 均 404)，必须指向显式文件 index.html。
     landing 会再读 ./tools.json 渲染成卡片、点卡落到 item.url 二级页。
     用根绝对路径避开 base/反代与皮肤深度差异(无 <base>，见 doc_frontend §3.3)。
     真机实测(main dec7ef7 之后)发现裸目录 404，已改为显式 index.html——本次修复。 */
  var TOOLS_HOME = '/static/xiaomusic_tools/index.html';

  /* 注入出的节点标记，避免重复注入（同一会话/多次执行时只 append 一次）。 */
  var MARK_ATTR = 'data-xtools-entry';
  var MARK_VAL  = '1';

  function inject() {
    /* 挂载点：主页里“设备功能入口行”`.mode-controls` 容器。一次定位，找不到就静默中止，
       不影响页面其它区域。 */
    var host = document.querySelector('.mode-controls.button-group');
    if (!host) { return; }

    if (host.querySelector('[' + MARK_ATTR + '="' + MARK_VAL + '"]')) { return; } /* 已注入，跳过 */

    /* 镜像在线搜索/设置等既有 icon-item 结构(class 复用 main.css 的样式)。 */
    var btn = document.createElement('div');
    btn.className = 'icon-item device-enable';
    btn.setAttribute(MARK_ATTR, MARK_VAL);
    btn.setAttribute('role', 'button');
    btn.setAttribute('aria-label', '小爱音箱工具');

    var span = document.createElement('span');
    span.className = 'material-icons';
    span.setAttribute('aria-hidden', 'true');
    span.textContent = 'extension'; /* Material Icons 字形；即便某字体缺字形，下方 <p> 仍显示“工具” */
    btn.appendChild(span);

    var p = document.createElement('p');
    p.textContent = '工具';
    btn.appendChild(p);

    /* 只在自身节点挂 click；点击→跳 landing。tabindex 保证可聚焦；
       md.js 的 document 级 keydown 会为 [role=button] 触发 Enter/Space→$(this).click()，
       与其它图标按钮同行为，本节点不需要额外键盘处理(会走同一条 click)。 */
    btn.addEventListener('click', function () {
      window.location.href = TOOLS_HOME;
    });
    btn.tabIndex = 0;

    host.appendChild(btn);
  }

  /* 主页里本脚本被放到正文末尾、md.js 之后；DOM 此时基本就绪。仍以 DOMContentLoaded 兜底以防异步。 */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', inject);
  } else {
    inject();
  }
})();
