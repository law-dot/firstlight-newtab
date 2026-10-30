// 番茄钟：点击时钟触发，Web Audio 提示音，设置存 data.settings.pomodoro
import { state, persist } from '../core/state.js';
import { $, toast } from '../core/utils.js';
import { tickClock } from '../app.js';

export const pomo = {
  state: {
    phase: 'work',        // work | shortBreak | longBreak
    running: false,
    paused: false,
    remaining: null,      // 剩余秒
    endsAt: null,         // 结束时间戳
    completed: 0          // 已完成的专注轮数
  },
  dialog: null,
  // 访问当前设置（从 data.settings.pomodoro 取最新值）
  get setting() { return state.data.settings.pomodoro; },
  phaseLabel(phase = this.state.phase) {
    return { work: '专注', shortBreak: '短休', longBreak: '长休' }[phase] || '专注';
  },
  phaseMinutes(phase) {
    return this.setting[phase === 'work' ? 'work' : phase === 'shortBreak' ? 'shortBreak' : 'longBreak'];
  },
  open() {
    if (!this.dialog) return;
    this.dialog.showModal();
    this.refreshDialog();
  },
  close() {
    if (this.dialog) this.dialog.close();
  },
  refreshDialog() {
    const s = this.setting;
    $('#pomoWork').value = s.work;
    $('#pomoShort').value = s.shortBreak;
    $('#pomoLong').value = s.longBreak;
    $('#pomoEvery').value = s.longBreakEvery;
    $('#pomoAuto').checked = !!s.autoNext;
    $('#pomoSound').checked = !!s.soundOn;

    const st = this.state;
    // 弹窗大显示：运行中/暂停显示剩余，否则显示当前 phase 的完整时长
    const displaySecs = st.running || st.paused
      ? st.remaining
      : this.phaseMinutes(st.phase) * 60;
    const m = Math.floor(displaySecs / 60);
    const sec = displaySecs % 60;
    $('#pomoDisplay').textContent =
      String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
    $('#pomoPhase').textContent = this.phaseLabel(st.phase).toUpperCase();
    $('#pomoRound').textContent = st.running || st.paused
      ? `${st.completed}/${s.longBreakEvery} 轮`
      : st.completed > 0
        ? `已完成 ${st.completed} 轮`
        : '';

    $('#pomoStart').hidden = st.running;
    $('#pomoPause').hidden = !st.running && !st.paused;
    $('#pomoPause').textContent = st.paused ? '继续' : '暂停';
    $('#pomoSkip').hidden = !st.running && !st.paused;
  },
  start() {
    const total = this.phaseMinutes(this.state.phase) * 60;
    if (this.state.paused && this.state.remaining != null) {
      // 从暂停恢复
      this.state.endsAt = Date.now() + this.state.remaining * 1000;
    } else {
      this.state.remaining = total;
      this.state.endsAt = Date.now() + total * 1000;
    }
    this.state.running = true;
    this.state.paused = false;
    this.refreshDialog();
    tickClock();
  },
  pause() {
    if (!this.state.running) return;
    this.state.running = false;
    this.state.paused = true;
    this.state.remaining = Math.max(0, Math.round((this.state.endsAt - Date.now()) / 1000));
    this.state.endsAt = null;
    this.refreshDialog();
    tickClock();
  },
  reset() {
    this.state.running = false;
    this.state.paused = false;
    this.state.remaining = null;
    this.state.endsAt = null;
    this.state.phase = 'work';
    this.state.completed = 0;
    this.refreshDialog();
    tickClock();
  },
  skip() {
    // 跳过当前 phase = 直接 finish
    this.state.remaining = 0;
    this.finishPhase(true);
  },
  finishPhase(skipped = false) {
    const s = this.setting;
    const endedPhase = this.state.phase;

    // 结束提示音
    if (s.soundOn) this.beep(endedPhase === 'work' ? [880, 660] : [523, 659, 784]);

    // 更新轮次
    if (endedPhase === 'work') this.state.completed += 1;

    // 决定下一个 phase
    if (endedPhase === 'work') {
      this.state.phase = (this.state.completed % s.longBreakEvery === 0) ? 'longBreak' : 'shortBreak';
    } else {
      // 休息结束 → 回到专注
      this.state.phase = 'work';
    }

    this.state.running = false;
    this.state.paused = false;
    this.state.remaining = null;
    this.state.endsAt = null;

    // 弹窗 toast 提醒
    const fromLabel = this.phaseLabel(endedPhase);
    const nextLabel = this.phaseLabel(this.state.phase);
    toast(`${fromLabel}结束 · ${nextLabel} ${this.phaseMinutes(this.state.phase)} 分`);

    // 若 autoNext 开启，自动开始下一段（给用户 1.5s 看清提示）
    if (s.autoNext && !skipped) {
      setTimeout(() => this.start(), 1500);
    } else {
      this.refreshDialog();
      tickClock();
    }
  },
  /* —— 纯 Web Audio 提示音，无外部文件 —— */
  beep(freqs = [660, 880]) {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const now = ctx.currentTime;
      freqs.forEach((f, i) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = 'sine';
        o.frequency.value = f;
        g.gain.setValueAtTime(0, now + i * 0.22);
        g.gain.linearRampToValueAtTime(0.18, now + i * 0.22 + 0.03);
        g.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.22 + 0.5);
        o.connect(g).connect(ctx.destination);
        o.start(now + i * 0.22);
        o.stop(now + i * 0.22 + 0.55);
      });
      setTimeout(() => ctx.close(), freqs.length * 250 + 300);
    } catch { /* audio blocked */ }
  },
  /* —— 保存设置到 store —— */
  saveSettings() {
    const w = parseInt($('#pomoWork').value, 10);
    const sb = parseInt($('#pomoShort').value, 10);
    const lb = parseInt($('#pomoLong').value, 10);
    const every = parseInt($('#pomoEvery').value, 10);
    if (isFinite(w)) state.data.settings.pomodoro.work = Math.max(1, Math.min(180, w));
    if (isFinite(sb)) state.data.settings.pomodoro.shortBreak = Math.max(1, Math.min(60, sb));
    if (isFinite(lb)) state.data.settings.pomodoro.longBreak = Math.max(1, Math.min(60, lb));
    if (isFinite(every)) state.data.settings.pomodoro.longBreakEvery = Math.max(1, Math.min(12, every));
    state.data.settings.pomodoro.autoNext = $('#pomoAuto').checked;
    state.data.settings.pomodoro.soundOn = $('#pomoSound').checked;
    persist();
    this.refreshDialog();
    tickClock();
  }
};

export function bindPomodoro() {
  pomo.dialog = $('#pomoDialog');
  $('#clock').addEventListener('click', (e) => {
    // 点击日期按钮时不触发番茄钟
    if (e.target.closest('#dateBtn')) return;
    e.preventDefault();
    pomo.open();
  });
  $('#clock').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      if (e.target.closest('#dateBtn')) return;
      e.preventDefault();
      pomo.open();
    }
  });
  $('#pomoStart').addEventListener('click', () => pomo.start());
  $('#pomoPause').addEventListener('click', () => {
    if (pomo.state.running) pomo.pause();
    else if (pomo.state.paused) pomo.start();
  });
  $('#pomoReset').addEventListener('click', () => pomo.reset());
  $('#pomoSkip').addEventListener('click', () => pomo.skip());
  ['#pomoWork', '#pomoShort', '#pomoLong', '#pomoEvery', '#pomoAuto', '#pomoSound']
    .forEach((sel) => $(sel).addEventListener('change', () => pomo.saveSettings()));
}
