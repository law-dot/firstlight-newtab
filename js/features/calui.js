// 日历订阅管理（ICS）：从设置面板迁到 RSS 页的弹窗里。
// RSS 页本身不管日历——rss.js 的 rssFeeds() 已把 kind:'ics' 过滤掉，
// 两类订阅共用 state.data.feeds 存储，但 UI 和抓取通道完全分开。
import { $, toast } from '../core/utils.js';
import {
  addFeed, removeFeed, syncFeed, listFeeds, feedRuntime,
  defaultFeedName, ensureFeedPermission
} from './calfeed.js';

/* ---------- 订阅列表 ---------- */

export function renderCalList() {
  const list = $('#calList');
  if (!list) return;
  list.textContent = '';
  const feeds = listFeeds();
  if (feeds.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'feed-empty';
    empty.textContent = '暂无日历订阅';
    list.append(empty);
    return;
  }
  for (const f of feeds) {
    const li = document.createElement('li');
    li.className = 'feed-item';

    const rt = feedRuntime(f.id); // 同步时间 / 失败原因只存在本机，不在 feeds 里

    const dot = document.createElement('i');
    dot.className = 'feed-color';
    dot.style.background = f.color || '#888';

    const info = document.createElement('div');
    info.className = 'feed-info';
    const name = document.createElement('div');
    name.className = 'feed-name';
    name.textContent = f.title || defaultFeedName(f.url);
    const url = document.createElement('div');
    url.className = 'feed-url';
    url.textContent = f.url;
    const status = document.createElement('div');
    status.className = 'feed-status';
    if (rt.error) status.textContent = `❌ ${rt.error}`;
    else if (rt.lastSync) status.textContent = `✓ ${new Date(rt.lastSync).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
    else status.textContent = '未同步';
    info.append(name, url, status);

    const syncBtn = document.createElement('button');
    syncBtn.className = 'btn small';
    syncBtn.type = 'button';
    syncBtn.textContent = '刷新';
    syncBtn.onclick = async () => {
      toast('同步中…');
      await syncFeed(f.id);
      renderCalList();
      toast(feedRuntime(f.id).error ? '同步失败' : '已同步');
    };

    const delBtn = document.createElement('button');
    delBtn.className = 'btn danger small';
    delBtn.type = 'button';
    delBtn.textContent = '删除';
    delBtn.onclick = () => {
      if (confirm(`删除订阅「${f.title || defaultFeedName(f.url)}」？`)) {
        removeFeed(f.id);
        renderCalList();
      }
    };

    li.append(dot, info, syncBtn, delBtn);
    list.append(li);
  }
}

/* ---------- 绑定 ---------- */

export function bindCalUI() {
  $('#calBtn')?.addEventListener('click', () => {
    renderCalList();
    $('#calDialog').showModal();
  });
  // 点遮罩或「关闭」按钮退出（与 RSS 添加源弹窗同一套交互）
  $('#calDialog')?.addEventListener('click', (e) => {
    if (e.target === $('#calDialog') || e.target.dataset?.close !== undefined) {
      $('#calDialog').close();
    }
  });
  $('#calForm')?.addEventListener('submit', onAddCal);
}

async function onAddCal(e) {
  e.preventDefault();
  const url = $('#calUrl').value.trim();
  const name = $('#calName').value.trim();
  if (!url) { toast('请输入 ICS 地址'); return; }
  // 先请求目标域名的访问权限（扩展环境；Web 预览直接过）
  const ok = await ensureFeedPermission(url);
  if (!ok) { toast('未授权访问该域名'); return; }
  const result = addFeed({ url, name });
  if (!result.ok) { toast(result.error); return; }
  $('#calUrl').value = '';
  $('#calName').value = '';
  toast('已添加，正在同步…');
  renderCalList();
}
