(function op74FloatingMusicPlayerBootstrap() {
  'use strict';

  /**
   * Op.74 野餐 · 悬浮音乐播放器（功能原型）
   *
   * 维护入口：通常只需要修改 USER_CONFIG。
   * 也可以在脚本执行前设置 window.OP74_FLOATING_MUSIC_CONFIG 覆盖同名字段。
   */
  const USER_CONFIG = {
    title: 'Op.74 音乐播放器',
    indexUrl: 'https://api.github.com/repos/ZKingsman/Op74-Recorder/git/trees/main?recursive=1',
    albumName: 'Op.74 Recorder',
    headerImage: '',
    defaultCover: '',
    tracks: [
      // { name: '曲目名称', url: 'https://example.com/music.mp3', album: '专辑名', cover: 'https://example.com/cover.jpg' },
    ],
    cacheAudio: true,
    initialVolume: 0.6,
    initialMode: 'sequence',
    requestTimeoutMs: 12000,
  };

  const VERSION = '0.8.2';
  const RUNTIME_KEY = '__OP74_FLOATING_MUSIC_PLAYER__';
  const ROOT_ID = 'op74-fmp-root';
  const STYLE_ID = 'op74-fmp-style';
  const STORAGE_KEY = 'op74:picnic:floating-music-player:v1';
  const EDGE_GAP = 8;
  const DRAG_THRESHOLD = 5;
  const AUDIO_PATH_PATTERN = /\.(?:aac|flac|m4a|mp3|oga|ogg|opus|wav|webm)$/i;
  const AUDIO_CACHE_NAME = 'op74-floating-music-audio-v3';
  const LEGACY_AUDIO_CACHE_NAMES = [
    'op74-floating-music-audio-v1',
    'op74-floating-music-audio-v2',
  ];

  const sourceWindow = window;
  const hostWindow = resolveHostWindow();
  const hostDocument = hostWindow.document;

  if (!hostDocument || !hostDocument.documentElement) {
    console.error('[Op.74 悬浮音乐播放器] 找不到可用的宿主文档。');
    return;
  }

  const previousRuntime = hostWindow[RUNTIME_KEY];
  if (previousRuntime && typeof previousRuntime.destroy === 'function') {
    try {
      previousRuntime.destroy();
    } catch (error) {
      console.warn('[Op.74 悬浮音乐播放器] 清理旧实例失败。', error);
    }
  }
  removeStaleNodes();

  if (!hostDocument.body) {
    hostDocument.addEventListener('DOMContentLoaded', install, { once: true });
  } else {
    install();
  }

  function resolveHostWindow() {
    try {
      if (
        sourceWindow.parent &&
        sourceWindow.parent !== sourceWindow &&
        sourceWindow.parent.document
      ) {
        return sourceWindow.parent;
      }
    } catch (_error) {
      // 跨域或受限 iframe：降级挂载在当前文档。
    }
    return sourceWindow;
  }

  function removeStaleNodes() {
    try {
      hostDocument.getElementById(ROOT_ID)?.remove();
      hostDocument.getElementById(STYLE_ID)?.remove();
    } catch (_error) {
      // 旧节点清理失败不应阻止新实例尝试安装。
    }
  }

  function install() {
    const externalConfig = readExternalConfig();
    const config = normalizeConfig({ ...USER_CONFIG, ...externalConfig });
    const preferences = readPreferences(config);
    const state = {
      destroyed: false,
      expanded: false,
      closing: false,
      playlistExpanded: false,
      loading: false,
      waiting: false,
      caching: false,
      error: '',
      notice: '',
      noticeKind: 'info',
      tracks: [],
      index: -1,
      playing: false,
      currentTime: 0,
      duration: 0,
      loadedTrackUrl: '',
      activeObjectUrl: '',
      sourceRevision: '',
      playGeneration: 0,
      mode: preferences.mode,
      volume: preferences.volume,
      x: preferences.x,
      y: preferences.y,
      playlistGeneration: 0,
      loadController: null,
      drag: null,
      suppressLauncherClick: false,
      resizeFrame: 0,
      trackMeasureFrame: 0,
      closeFallbackTimer: 0,
    };

    const disposers = [];
    const cachedTrackUrls = new Set();
    const cacheJobs = new Map();
    const audio = new hostWindow.Audio();
    audio.preload = 'metadata';
    audio.volume = state.volume;

    const style = hostDocument.createElement('style');
    style.id = STYLE_ID;
    style.textContent = cssText();
    (hostDocument.head || hostDocument.documentElement).appendChild(style);

    const ui = buildUi(config.title);
    hostDocument.body.appendChild(ui.root);

    const runtime = {
      version: VERSION,
      destroy,
      open: () => setExpanded(true),
      close: () => setExpanded(false),
      reloadPlaylist: () => loadPlaylist(true),
      clearAudioCache,
      getState: () => ({
        expanded: state.expanded,
        closing: state.closing,
        playlistExpanded: state.playlistExpanded,
        loading: state.loading,
        caching: state.caching,
        cacheEnabled: canUseAudioCache(),
        cacheName: AUDIO_CACHE_NAME,
        cachedTrackCount: cachedTrackUrls.size,
        error: state.error,
        trackCount: state.tracks.length,
        index: state.index,
        playing: state.playing,
        currentTime: state.currentTime,
        duration: state.duration,
        sourceRevision: state.sourceRevision,
        mode: state.mode,
        volume: state.volume,
      }),
    };
    hostWindow[RUNTIME_KEY] = runtime;

    bindUiEvents();
    bindAudioEvents();
    restorePosition();
    renderTrackList();
    render();
    loadPlaylist(false);

    console.info(`[Op.74 悬浮音乐播放器] 已加载 v${VERSION}`);

    function readExternalConfig() {
      const candidates = [];
      try {
        candidates.push(hostWindow.OP74_FLOATING_MUSIC_CONFIG);
      } catch (_error) {}
      try {
        if (sourceWindow !== hostWindow) {
          candidates.push(sourceWindow.OP74_FLOATING_MUSIC_CONFIG);
        }
      } catch (_error) {}
      return candidates.find((value) => value && typeof value === 'object') || {};
    }

    function normalizeConfig(raw) {
      const initialMode = raw.initialMode === 'shuffle' ? 'shuffle' : 'sequence';
      return {
        title: stringOrFallback(raw.title, '悬浮音乐播放器', 80),
        indexUrl: typeof raw.indexUrl === 'string' ? raw.indexUrl.trim() : '',
        albumName: typeof raw.albumName === 'string' ? raw.albumName.trim() : '',
        headerImage: normalizeImageUrl(
          raw.headerImage || raw.bannerImage || raw.heroImage,
          hostWindow.location.href,
        ) || '',
        defaultCover: typeof raw.defaultCover === 'string' ? raw.defaultCover.trim() : '',
        tracks: Array.isArray(raw.tracks) ? raw.tracks : [],
        cacheAudio: raw.cacheAudio !== false,
        initialVolume: clampNumber(raw.initialVolume, 0, 1, 0.6),
        initialMode,
        requestTimeoutMs: clampNumber(raw.requestTimeoutMs, 2000, 60000, 12000),
      };
    }

    function readPreferences(normalizedConfig) {
      const fallback = {
        mode: normalizedConfig.initialMode,
        volume: normalizedConfig.initialVolume,
        x: null,
        y: null,
      };
      try {
        const raw = hostWindow.localStorage.getItem(STORAGE_KEY);
        if (!raw) return fallback;
        const parsed = JSON.parse(raw);
        if (!parsed || parsed.version !== 1) return fallback;
        return {
          mode: parsed.mode === 'shuffle' ? 'shuffle' : 'sequence',
          volume: clampNumber(parsed.volume, 0, 1, fallback.volume),
          x: finiteOrNull(parsed.x),
          y: finiteOrNull(parsed.y),
        };
      } catch (_error) {
        return fallback;
      }
    }

    function savePreferences() {
      try {
        hostWindow.localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({
            version: 1,
            mode: state.mode,
            volume: state.volume,
            x: state.x,
            y: state.y,
          }),
        );
      } catch (_error) {
        // localStorage 不可用时仅放弃持久化，不影响播放器。
      }
    }

    function buildUi(title) {
      const root = element('div', 'op74-fmp-root');
      root.id = ROOT_ID;

      const launcher = element('button', 'op74-fmp-launcher');
      launcher.type = 'button';
      launcher.title = '打开音乐播放器；可拖动';
      launcher.setAttribute('aria-label', '打开悬浮音乐播放器');
      launcher.setAttribute('aria-controls', 'op74-fmp-panel');
      launcher.setAttribute('aria-expanded', 'false');
      launcher.appendChild(createStarburstMark('op74-fmp-launcher-mark'));
      root.appendChild(launcher);

      const panel = element('section', 'op74-fmp-panel');
      panel.id = 'op74-fmp-panel';
      panel.hidden = true;
      panel.setAttribute('role', 'region');
      panel.setAttribute('aria-label', title);

      const heading = element('h2', 'op74-fmp-sr-only');
      heading.textContent = title;

      const main = element('div', 'op74-fmp-main');
      const dragSurface = element('div', 'op74-fmp-album-stage');
      dragSurface.title = '拖动播放器';
      const albumFrame = element('div', 'op74-fmp-album-frame');
      const albumCover = hostDocument.createElement('img');
      albumCover.className = 'op74-fmp-album-cover';
      albumCover.alt = '';
      albumCover.hidden = true;
      albumCover.decoding = 'async';
      albumCover.referrerPolicy = 'no-referrer';
      const albumFallback = element('div', 'op74-fmp-album-fallback');
      albumFallback.appendChild(createStarburstMark('op74-fmp-cover-mark'));
      const closeButton = iconButton('collapse', '收起音乐播放器');
      closeButton.classList.add('op74-fmp-overlay-close');
      albumFrame.append(albumFallback, albumCover);
      dragSurface.append(albumFrame, closeButton);

      const meta = element('div', 'op74-fmp-meta');
      const nowTitle = element('div', 'op74-fmp-now-title');
      nowTitle.textContent = '—';
      const nowAlbum = element('div', 'op74-fmp-now-album');
      meta.append(nowTitle, nowAlbum);

      const controls = element('nav', 'op74-fmp-controls');
      controls.setAttribute('aria-label', '播放控制');
      const modeButton = iconButton('sequence', '当前顺序播放，切换为随机播放');
      modeButton.classList.add('op74-fmp-mode-key');
      const previousButton = iconButton('previous', '播放上一首');
      const playButton = iconButton('play', '开始播放');
      playButton.classList.add('op74-fmp-primary-key');
      const nextButton = iconButton('next', '播放下一首');
      const playlistButton = iconButton('playlist', '展开播放列表');
      playlistButton.classList.add('op74-fmp-playlist-key');
      playlistButton.setAttribute('aria-controls', 'op74-fmp-track-list');
      playlistButton.setAttribute('aria-expanded', 'false');
      controls.append(modeButton, previousButton, playButton, nextButton, playlistButton);

      const transport = element('div', 'op74-fmp-transport');
      const progress = hostDocument.createElement('input');
      progress.className = 'op74-fmp-progress';
      progress.type = 'range';
      progress.min = '0';
      progress.max = '1000';
      progress.step = '1';
      progress.value = '0';
      progress.disabled = true;
      progress.setAttribute('aria-label', '播放进度');
      const timeDisplay = element('output', 'op74-fmp-time-display');
      timeDisplay.textContent = '0:00/0:00';
      timeDisplay.setAttribute('aria-label', '播放时间');
      transport.append(progress, timeDisplay);

      const volumeLabel = element('label', 'op74-fmp-volume-row');
      const volumeIcon = element('span', 'op74-fmp-volume-icon');
      volumeIcon.appendChild(createControlIcon('volume'));
      const volume = hostDocument.createElement('input');
      volume.type = 'range';
      volume.min = '0';
      volume.max = '1';
      volume.step = '0.05';
      volume.value = String(state.volume);
      volume.setAttribute('aria-label', '音量');
      volumeLabel.append(volumeIcon, volume);

      const statusRow = element('div', 'op74-fmp-status-row');
      const status = element('div', 'op74-fmp-status');
      status.setAttribute('role', 'status');
      status.setAttribute('aria-live', 'polite');

      const retryButton = iconButton('retry', '重新加载歌单');
      retryButton.classList.add('op74-fmp-retry');
      retryButton.hidden = true;
      statusRow.append(status, retryButton);

      const listHeading = element('h3', 'op74-fmp-sr-only');
      listHeading.textContent = '歌单';
      const trackList = element('ul', 'op74-fmp-track-list');
      trackList.id = 'op74-fmp-track-list';
      trackList.setAttribute('aria-label', '歌曲列表');
      trackList.setAttribute('aria-hidden', 'true');

      main.append(
        dragSurface,
        meta,
        transport,
        volumeLabel,
        controls,
        statusRow,
        listHeading,
        trackList,
      );
      panel.append(heading, main);
      root.appendChild(panel);

      return {
        root,
        launcher,
        panel,
        dragSurface,
        closeButton,
        albumCover,
        albumFallback,
        nowTitle,
        nowAlbum,
        progress,
        timeDisplay,
        modeButton,
        previousButton,
        playButton,
        nextButton,
        playlistButton,
        volume,
        statusRow,
        status,
        retryButton,
        trackList,
      };
    }

    function element(tagName, className) {
      const node = hostDocument.createElement(tagName);
      if (className) node.className = className;
      return node;
    }

    function iconButton(icon, label) {
      const button = element('button', 'op74-fmp-key');
      button.type = 'button';
      button.setAttribute('aria-label', label);
      button.title = label;
      setButtonIcon(button, icon);
      return button;
    }

    function setButtonIcon(button, icon) {
      if (button.dataset.icon === icon) return;
      button.dataset.icon = icon;
      button.replaceChildren(createControlIcon(icon));
    }

    function createControlIcon(name) {
      const svg = svgNode('svg', {
        class: 'op74-fmp-icon',
        viewBox: '0 0 24 24',
        'aria-hidden': 'true',
        focusable: 'false',
      });
      const stroked = (tag, attributes) => svgNode(tag, {
        fill: 'none',
        stroke: 'currentColor',
        'stroke-width': '1.8',
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
        ...attributes,
      });
      if (name === 'play') {
        svg.appendChild(svgNode('path', { d: 'M8 5.2v13.6L18.5 12z', fill: 'currentColor' }));
      } else if (name === 'pause') {
        svg.append(
          svgNode('rect', { x: '7', y: '5', width: '3.5', height: '14', rx: '1', fill: 'currentColor' }),
          svgNode('rect', { x: '13.5', y: '5', width: '3.5', height: '14', rx: '1', fill: 'currentColor' }),
        );
      } else if (name === 'previous') {
        svg.append(
          stroked('path', { d: 'M6 5v14' }),
          svgNode('path', { d: 'M18.5 5.5 8.5 12l10 6.5z', fill: 'currentColor' }),
        );
      } else if (name === 'next') {
        svg.append(
          svgNode('path', { d: 'M5.5 5.5 15.5 12l-10 6.5z', fill: 'currentColor' }),
          stroked('path', { d: 'M18 5v14' }),
        );
      } else if (name === 'shuffle') {
        svg.append(
          stroked('path', { d: 'M4 7h2.4c4.2 0 5.2 10 9.6 10h4' }),
          stroked('path', { d: 'm17 14 3 3-3 3' }),
          stroked('path', { d: 'M4 17h2.4c2 0 3.2-2.3 4.3-4.7M14.2 7H20' }),
          stroked('path', { d: 'm17 4 3 3-3 3' }),
        );
      } else if (name === 'sequence') {
        svg.append(
          stroked('path', { d: 'M5 7h14l-3-3M19 7l-3 3' }),
          stroked('path', { d: 'M19 17H5l3 3M5 17l3-3' }),
        );
      } else if (name === 'playlist') {
        svg.append(
          svgNode('circle', { cx: '5', cy: '6.5', r: '1.25', fill: 'currentColor' }),
          svgNode('circle', { cx: '5', cy: '12', r: '1.25', fill: 'currentColor' }),
          svgNode('circle', { cx: '5', cy: '17.5', r: '1.25', fill: 'currentColor' }),
          stroked('path', { d: 'M9 6.5h11M9 12h11M9 17.5h11' }),
        );
      } else if (name === 'collapse') {
        svg.append(stroked('path', { d: 'm5 8 7 8 7-8' }));
      } else if (name === 'retry') {
        svg.append(
          stroked('path', { d: 'M19 7v5h-5' }),
          stroked('path', { d: 'M18.2 12A6.5 6.5 0 1 1 16.8 7' }),
        );
      } else if (name === 'volume') {
        svg.append(
          svgNode('path', { d: 'M4 9v6h4l5 4V5L8 9z', fill: 'currentColor' }),
          stroked('path', { d: 'M16 9.2a4 4 0 0 1 0 5.6M18.4 7a7 7 0 0 1 0 10' }),
        );
      }
      return svg;
    }

    function createStarburstMark(className) {
      const svg = svgNode('svg', {
        class: className,
        viewBox: '0 0 100 100',
        'aria-hidden': 'true',
        focusable: 'false',
      });
      svg.appendChild(svgNode('circle', { cx: '50', cy: '50', r: '47', fill: '#111824' }));
      const rays = svgNode('g', { class: 'op74-fmp-star-rays' });
      for (let index = 0; index < 24; index += 1) {
        const angle = (Math.PI * 2 * index) / 24 - Math.PI / 2;
        const inner = index % 2 === 0 ? 17 : 20;
        const outer = index % 3 === 0 ? 45 : 41;
        rays.appendChild(svgNode('line', {
          x1: String(50 + Math.cos(angle) * inner),
          y1: String(50 + Math.sin(angle) * inner),
          x2: String(50 + Math.cos(angle) * outer),
          y2: String(50 + Math.sin(angle) * outer),
        }));
      }
      const points = [];
      for (let index = 0; index < 10; index += 1) {
        const angle = (Math.PI * 2 * index) / 10 - Math.PI / 2;
        const radius = index % 2 === 0 ? 18 : 7.5;
        points.push(`${50 + Math.cos(angle) * radius},${50 + Math.sin(angle) * radius}`);
      }
      svg.append(
        rays,
        svgNode('circle', { cx: '50', cy: '50', r: '43', fill: 'none', stroke: '#d5aa55', 'stroke-width': '2.2' }),
        svgNode('circle', { cx: '50', cy: '50', r: '32', fill: 'none', stroke: '#d5aa55', 'stroke-width': '1', opacity: '0.75' }),
        svgNode('polygon', { points: points.join(' '), fill: '#f3c849', stroke: '#fff4c7', 'stroke-width': '1.3' }),
        svgNode('circle', { cx: '50', cy: '50', r: '3.6', fill: '#fff8d8' }),
      );
      return svg;
    }

    function svgNode(tagName, attributes) {
      const node = hostDocument.createElementNS('http://www.w3.org/2000/svg', tagName);
      Object.entries(attributes || {}).forEach(([name, value]) => node.setAttribute(name, String(value)));
      return node;
    }

    function bindUiEvents() {
      on(ui.launcher, 'pointerdown', (event) => beginDrag(event, 'launcher'));
      on(ui.launcher, 'click', () => {
        if (state.suppressLauncherClick) {
          state.suppressLauncherClick = false;
          return;
        }
        setExpanded(true);
      });
      on(ui.dragSurface, 'pointerdown', (event) => beginDrag(event, 'panel'));
      on(ui.albumCover, 'load', () => {
        ui.albumCover.hidden = false;
        ui.albumFallback.hidden = true;
      });
      on(ui.albumCover, 'error', () => {
        ui.albumCover.hidden = true;
        ui.albumFallback.hidden = false;
      });
      on(ui.closeButton, 'click', () => setExpanded(false));
      on(ui.playButton, 'click', togglePlayback);
      on(ui.previousButton, 'click', previousTrack);
      on(ui.nextButton, 'click', nextTrack);
      on(ui.modeButton, 'click', toggleMode);
      on(ui.playlistButton, 'click', () => setPlaylistExpanded(!state.playlistExpanded));
      on(ui.progress, 'input', handleSeek);
      on(ui.volume, 'input', handleVolume);
      on(ui.retryButton, 'click', () => loadPlaylist(true));
      on(ui.trackList, 'click', (event) => {
        const button = event.target.closest('button[data-track-index]');
        if (!button) return;
        const index = Number(button.dataset.trackIndex);
        if (Number.isInteger(index)) playTrack(index);
      });
      on(ui.trackList, 'transitionend', (event) => {
        if (event.propertyName === 'max-height') clampPosition();
      });
      on(ui.panel, 'animationend', (event) => {
        if (event.animationName === 'op74-fmp-panel-open') {
          delete ui.root.dataset.opening;
        } else if (event.animationName === 'op74-fmp-panel-close') {
          finishClosingAnimation();
        }
      });
      on(hostDocument, 'keydown', (event) => {
        if (event.key === 'Escape' && state.expanded) {
          event.preventDefault();
          setExpanded(false);
        }
      });
      on(hostWindow, 'resize', scheduleClamp);
      if (hostWindow.visualViewport) {
        on(hostWindow.visualViewport, 'resize', scheduleClamp);
        on(hostWindow.visualViewport, 'scroll', scheduleClamp);
      }
      on(sourceWindow, 'pagehide', destroy, { once: true });
      if (sourceWindow !== hostWindow) {
        on(hostWindow, 'pagehide', destroy, { once: true });
      }
    }

    function bindAudioEvents() {
      on(audio, 'play', () => {
        state.playing = true;
        state.waiting = false;
        setNotice('', 'info');
        render();
      });
      on(audio, 'pause', () => {
        state.playing = false;
        state.waiting = false;
        render();
      });
      on(audio, 'waiting', () => {
        state.waiting = true;
        render();
      });
      on(audio, 'canplay', () => {
        state.waiting = false;
        render();
      });
      on(audio, 'timeupdate', updateAudioTime);
      on(audio, 'durationchange', updateAudioTime);
      on(audio, 'loadedmetadata', updateAudioTime);
      on(audio, 'ended', () => nextTrack());
      on(audio, 'error', () => {
        state.playing = false;
        state.waiting = false;
        setNotice(mediaErrorText(audio), 'error');
        render();
      });
    }

    function on(target, type, listener, options) {
      target.addEventListener(type, listener, options);
      disposers.push(() => target.removeEventListener(type, listener, options));
    }

    async function loadPlaylist(force) {
      if (state.destroyed || (state.loading && !force)) return;
      state.playlistGeneration += 1;
      const generation = state.playlistGeneration;
      state.loadController?.abort();
      state.loadController = null;
      state.loading = true;
      state.error = '';
      state.sourceRevision = '';
      setNotice('', 'info');
      render();

      try {
        let tracks = normalizeTracks(config.tracks, hostWindow.location.href, {
          album: config.albumName,
          cover: config.defaultCover,
        });
        if (!tracks.length && config.indexUrl) {
          tracks = await fetchTrackIndex(config.indexUrl, generation);
        }
        if (state.destroyed || generation !== state.playlistGeneration) return;
        state.tracks = tracks;
        if (!tracks.length) {
          state.index = -1;
          setNotice('尚未配置歌单。请在脚本顶部填写 tracks 或 indexUrl。', 'empty');
        } else if (state.index >= tracks.length) {
          state.index = -1;
          resetAudioSource();
        }
        if (tracks.length) void syncAudioCacheIndex(tracks);
      } catch (error) {
        if (state.destroyed || generation !== state.playlistGeneration) return;
        if (error && error.name === 'AbortError') return;
        state.error = error instanceof Error ? error.message : String(error);
      } finally {
        if (!state.destroyed && generation === state.playlistGeneration) {
          state.loading = false;
          state.loadController = null;
          renderTrackList();
          render();
        }
      }
    }

    async function fetchTrackIndex(indexUrl, generation) {
      const safeIndexUrl = normalizeUrl(indexUrl, hostWindow.location.href, false);
      if (!safeIndexUrl) throw new Error('歌单索引地址无效；仅允许 HTTP 或 HTTPS。');
      const githubSource = parseGitHubTreeSource(safeIndexUrl);
      const controller = new hostWindow.AbortController();
      state.loadController = controller;
      const timeout = hostWindow.setTimeout(() => controller.abort(), config.requestTimeoutMs);
      try {
        const sourceRevision = githubSource
          ? await resolveGitHubCommitSha(githubSource, controller.signal)
          : '';
        if (state.destroyed || generation !== state.playlistGeneration) {
          throw new hostWindow.DOMException('请求已失效', 'AbortError');
        }
        const resolvedIndexUrl = githubSource
          ? buildGitHubTreeUrl(githubSource, sourceRevision)
          : safeIndexUrl;
        const response = await hostWindow.fetch(resolvedIndexUrl, {
          signal: controller.signal,
          cache: 'no-store',
          credentials: 'omit',
        });
        if (!response.ok) throw new Error(`歌单加载失败：HTTP ${response.status}`);
        const contentLength = Number(response.headers.get('content-length'));
        if (Number.isFinite(contentLength) && contentLength > 1024 * 1024) {
          throw new Error('歌单索引超过 1MB 安全上限。');
        }
        const data = await response.json();
        if (state.destroyed || generation !== state.playlistGeneration) {
          throw new hostWindow.DOMException('请求已失效', 'AbortError');
        }
        const normalizedIndex = githubSource
          ? normalizeGitHubTreeIndex(data, githubSource, sourceRevision)
          : data;
        const tracks = normalizeTracks(normalizedIndex, safeIndexUrl, {
          album: config.albumName,
          cover: config.defaultCover,
        });
        if (!tracks.length) throw new Error('歌单索引中没有有效曲目。');
        state.sourceRevision = sourceRevision;
        return tracks;
      } catch (error) {
        if (controller.signal.aborted && (!error || error.name !== 'AbortError')) {
          throw new Error('歌单加载超时。');
        }
        throw error;
      } finally {
        hostWindow.clearTimeout(timeout);
      }
    }

    function parseGitHubTreeSource(indexUrl) {
      let parsedUrl;
      try {
        parsedUrl = new hostWindow.URL(indexUrl);
      } catch (_error) {
        return null;
      }
      if (parsedUrl.hostname.toLowerCase() !== 'api.github.com') return null;
      const match = parsedUrl.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/git\/trees\/([^/]+)$/i);
      if (!match) return null;
      return {
        owner: decodeURIComponent(match[1]),
        repository: decodeURIComponent(match[2]),
        reference: decodeURIComponent(match[3]),
      };
    }

    async function resolveGitHubCommitSha(source, signal) {
      if (/^[0-9a-f]{40}$/i.test(source.reference)) return source.reference.toLowerCase();
      const commitUrl = [
        'https://api.github.com/repos',
        encodeURIComponent(source.owner),
        encodeURIComponent(source.repository),
        'commits',
        encodeURIComponent(source.reference),
      ].join('/');
      const response = await hostWindow.fetch(commitUrl, {
        signal,
        cache: 'no-store',
        credentials: 'omit',
      });
      if (!response.ok) {
        throw new Error(`GitHub 提交版本解析失败：HTTP ${response.status}`);
      }
      const contentLength = Number(response.headers.get('content-length'));
      if (Number.isFinite(contentLength) && contentLength > 1024 * 1024) {
        throw new Error('GitHub 提交信息超过 1MB 安全上限。');
      }
      const data = await response.json();
      if (!data || typeof data.sha !== 'string' || !/^[0-9a-f]{40}$/i.test(data.sha)) {
        throw new Error('GitHub 未返回有效的完整 Commit SHA。');
      }
      return data.sha.toLowerCase();
    }

    function buildGitHubTreeUrl(source, commitSha) {
      return [
        'https://api.github.com/repos',
        encodeURIComponent(source.owner),
        encodeURIComponent(source.repository),
        'git/trees',
        commitSha,
      ].join('/') + '?recursive=1';
    }

    function normalizeGitHubTreeIndex(input, source, commitSha) {
      if (!input || typeof input !== 'object' || !Array.isArray(input.tree)) return null;
      if (input.truncated) {
        throw new Error('GitHub 仓库目录返回不完整，请改用独立歌单 JSON。');
      }
      if (!/^[0-9a-f]{40}$/i.test(commitSha)) {
        throw new Error('拒绝使用可变 GitHub 分支地址播放音频。');
      }
      const cdnBase = `https://cdn.jsdelivr.net/gh/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repository)}@${commitSha}/`;
      const tracks = [];
      for (const entry of input.tree.slice(0, 2000)) {
        if (!entry || entry.type !== 'blob' || typeof entry.path !== 'string') continue;
        const path = entry.path.replace(/^\/+/, '');
        if (!path || !AUDIO_PATH_PATTERN.test(path)) continue;
        const encodedPath = path.split('/').map((segment) => encodeURIComponent(segment)).join('/');
        tracks.push({
          name: displayName(path),
          url: `${cdnBase}${encodedPath}`,
        });
      }
      return {
        album: config.albumName || source.repository,
        tracks,
      };
    }

    function normalizeTracks(input, baseUrl, defaults) {
      const list = Array.isArray(input)
        ? input
        : input && typeof input === 'object'
          ? input.songs || input.tracks || input.music || input.list || []
          : [];
      if (!Array.isArray(list)) return [];
      const sharedAlbum = stringOrFallback(
        !Array.isArray(input) && input && typeof input === 'object'
          ? input.album || input.albumName || defaults?.album
          : defaults?.album,
        '',
        120,
      );
      const sharedCoverRaw = !Array.isArray(input) && input && typeof input === 'object'
        ? input.cover || input.coverUrl || input.artwork || input.image || defaults?.cover
        : defaults?.cover;
      const sharedCover = normalizeImageUrl(sharedCoverRaw, baseUrl);
      const seen = new Set();
      const tracks = [];
      for (const item of list.slice(0, 500)) {
        let name = '';
        let rawUrl = '';
        let album = sharedAlbum;
        let cover = sharedCover;
        let durationLabel = '';
        if (typeof item === 'string') {
          rawUrl = item;
          name = displayName(item);
        } else if (item && typeof item === 'object') {
          rawUrl = item.url || item.link || item.src || item.path || item.file || '';
          name = item.name || item.title || item.song || displayName(rawUrl);
          album = stringOrFallback(item.album || item.albumName || sharedAlbum, '', 120);
          cover = normalizeImageUrl(
            item.cover || item.coverUrl || item.artwork || item.image || sharedCover,
            baseUrl,
          );
          durationLabel = normalizeDurationLabel(item.duration ?? item.length ?? item.time);
        }
        const url = normalizeUrl(rawUrl, baseUrl, true);
        if (!url || seen.has(url)) continue;
        seen.add(url);
        tracks.push({
          name: stringOrFallback(name, `曲目 ${tracks.length + 1}`, 160),
          album,
          cover,
          durationLabel,
          url,
        });
      }
      return tracks;
    }

    function normalizeUrl(rawUrl, baseUrl, allowLocalMedia) {
      if (typeof rawUrl !== 'string' || !rawUrl.trim()) return null;
      try {
        const url = new hostWindow.URL(rawUrl.trim(), baseUrl);
        if (url.protocol === 'https:' || url.protocol === 'http:') return url.href;
        if (allowLocalMedia && url.protocol === 'blob:') return url.href;
        if (allowLocalMedia && url.protocol === 'data:' && /^data:audio\//i.test(rawUrl.trim())) {
          return rawUrl.trim();
        }
      } catch (_error) {}
      return null;
    }

    function normalizeImageUrl(rawUrl, baseUrl) {
      if (typeof rawUrl !== 'string' || !rawUrl.trim()) return null;
      try {
        const url = new hostWindow.URL(rawUrl.trim(), baseUrl);
        if (url.protocol === 'https:' || url.protocol === 'http:' || url.protocol === 'blob:') {
          return url.href;
        }
        if (url.protocol === 'data:' && /^data:image\//i.test(rawUrl.trim())) {
          return rawUrl.trim();
        }
      } catch (_error) {}
      return null;
    }

    function normalizeDurationLabel(value) {
      if (value !== '' && value !== null && value !== undefined && Number.isFinite(Number(value)) && Number(value) >= 0) {
        return formatTime(Number(value));
      }
      if (typeof value !== 'string') return '';
      const text = value.trim();
      return /^\d{1,3}:[0-5]\d$/.test(text) ? text : '';
    }

    function displayName(pathOrUrl) {
      try {
        const clean = String(pathOrUrl).split(/[?#]/)[0];
        const file = decodeURIComponent(clean.split('/').pop() || clean);
        return file.replace(/\.[a-z0-9]+$/i, '').trim();
      } catch (_error) {
        return '未命名曲目';
      }
    }

    async function playTrack(index) {
      const track = state.tracks[index];
      if (!track || state.destroyed) return;
      if (state.index === index && state.caching) return;
      if (state.index === index && state.loadedTrackUrl === track.url && audio.src) {
        try {
          await audio.play();
        } catch (error) {
          handlePlayError(error);
        }
        return;
      }

      const generation = ++state.playGeneration;
      state.index = index;
      state.currentTime = 0;
      state.duration = 0;
      state.caching = false;
      resetAudioElementOnly();
      releaseActiveObjectUrl();

      let cachedObjectUrl = '';
      if (canUseAudioCache() && cachedTrackUrls.has(track.url)) {
        state.caching = true;
        setNotice('正在读取本地缓存…', 'info');
        renderTrackList();
        render();
        cachedObjectUrl = await readCachedTrackObjectUrl(track.url);
        if (state.destroyed || generation !== state.playGeneration) {
          revokeObjectUrl(cachedObjectUrl);
          return;
        }
        state.caching = false;
      }

      if (cachedObjectUrl) {
        state.activeObjectUrl = cachedObjectUrl;
        audio.src = cachedObjectUrl;
        setNotice('正在从本地缓存播放…', 'info');
      } else {
        audio.src = track.url;
        setNotice('正在请求播放…', 'info');
        cacheTrackInBackground(track);
      }
      state.loadedTrackUrl = track.url;
      audio.load();
      renderTrackList();
      render();
      try {
        await audio.play();
      } catch (error) {
        handlePlayError(error);
      }
    }

    function handlePlayError(error) {
      if (error && error.name === 'NotAllowedError') {
        setNotice('播放被浏览器拦截，请再点一次“播放”。', 'error');
      } else if (error && error.name !== 'AbortError') {
        setNotice(`无法播放：${error.message || String(error)}`, 'error');
      }
      render();
    }

    function canUseAudioCache() {
      return Boolean(
        config.cacheAudio
        && hostWindow.caches
        && typeof hostWindow.caches.open === 'function'
        && typeof hostWindow.fetch === 'function',
      );
    }

    function isCacheableTrackUrl(url) {
      try {
        const parsed = new hostWindow.URL(url);
        return parsed.protocol === 'https:' || parsed.protocol === 'http:';
      } catch (_error) {
        return false;
      }
    }

    async function syncAudioCacheIndex(tracks) {
      if (!canUseAudioCache() || state.destroyed) return;
      const validUrls = new Set(tracks.map((track) => track.url).filter(isCacheableTrackUrl));
      try {
        await Promise.all(
          LEGACY_AUDIO_CACHE_NAMES.map((cacheName) => hostWindow.caches.delete(cacheName)),
        );
        const cache = await hostWindow.caches.open(AUDIO_CACHE_NAME);
        const requests = await cache.keys();
        cachedTrackUrls.clear();
        await Promise.all(requests.map(async (request) => {
          if (validUrls.has(request.url)) {
            cachedTrackUrls.add(request.url);
          } else {
            await cache.delete(request);
          }
        }));
      } catch (error) {
        console.warn('[Op.74 悬浮音乐播放器] 无法读取音频缓存索引，将继续在线播放。', error);
      }
    }

    async function readCachedTrackObjectUrl(url) {
      if (!canUseAudioCache() || !cachedTrackUrls.has(url)) return '';
      try {
        const cache = await hostWindow.caches.open(AUDIO_CACHE_NAME);
        const response = await cache.match(url);
        if (!response) {
          cachedTrackUrls.delete(url);
          return '';
        }
        const blob = await response.blob();
        if (!blob.size) {
          cachedTrackUrls.delete(url);
          await cache.delete(url);
          return '';
        }
        return hostWindow.URL.createObjectURL(blob);
      } catch (error) {
        cachedTrackUrls.delete(url);
        console.warn('[Op.74 悬浮音乐播放器] 本地音频缓存读取失败，将回退在线播放。', error);
        return '';
      }
    }

    function cacheTrackInBackground(track) {
      if (
        !canUseAudioCache()
        || !isCacheableTrackUrl(track.url)
        || cachedTrackUrls.has(track.url)
        || cacheJobs.has(track.url)
      ) return;

      const controller = new hostWindow.AbortController();
      const job = (async () => {
        const cache = await hostWindow.caches.open(AUDIO_CACHE_NAME);
        if (await cache.match(track.url)) {
          cachedTrackUrls.add(track.url);
          return;
        }
        const response = await hostWindow.fetch(track.url, {
          signal: controller.signal,
          cache: 'default',
          credentials: 'omit',
          mode: 'cors',
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        await cache.put(track.url, response.clone());
        cachedTrackUrls.add(track.url);
      })();

      cacheJobs.set(track.url, { controller, job });
      job.catch((error) => {
        if (!error || error.name !== 'AbortError') {
          console.warn(`[Op.74 悬浮音乐播放器] “${track.name}”缓存失败，将保留在线播放。`, error);
        }
      }).finally(() => {
        if (cacheJobs.get(track.url)?.job === job) cacheJobs.delete(track.url);
      });
    }

    async function clearAudioCache() {
      for (const { controller } of cacheJobs.values()) controller.abort();
      cacheJobs.clear();
      cachedTrackUrls.clear();
      if (!hostWindow.caches || typeof hostWindow.caches.delete !== 'function') return false;
      try {
        const results = await Promise.all(
          [AUDIO_CACHE_NAME, ...LEGACY_AUDIO_CACHE_NAMES]
            .map((cacheName) => hostWindow.caches.delete(cacheName)),
        );
        return results.some(Boolean);
      } catch (_error) {
        return false;
      }
    }

    function revokeObjectUrl(url) {
      if (!url) return;
      try {
        hostWindow.URL.revokeObjectURL(url);
      } catch (_error) {}
    }

    function releaseActiveObjectUrl() {
      revokeObjectUrl(state.activeObjectUrl);
      state.activeObjectUrl = '';
    }

    function togglePlayback() {
      if (!state.tracks.length || state.caching) return;
      if (state.index < 0) {
        playTrack(state.mode === 'shuffle' ? randomIndex() : 0);
        return;
      }
      if (audio.paused) {
        audio.play().catch((error) => {
          if (error && error.name === 'NotAllowedError') {
            setNotice('播放被浏览器拦截，请再点一次。', 'error');
          }
          render();
        });
      } else {
        audio.pause();
      }
    }

    function nextTrack() {
      if (!state.tracks.length) return;
      const index = state.mode === 'shuffle'
        ? randomIndex()
        : (Math.max(state.index, -1) + 1) % state.tracks.length;
      playTrack(index);
    }

    function previousTrack() {
      if (!state.tracks.length) return;
      const index = state.mode === 'shuffle'
        ? randomIndex()
        : (state.index - 1 + state.tracks.length) % state.tracks.length;
      playTrack(index);
    }

    function randomIndex() {
      const count = state.tracks.length;
      if (count <= 1) return 0;
      let index = state.index;
      while (index === state.index) index = Math.floor(Math.random() * count);
      return index;
    }

    function toggleMode() {
      state.mode = state.mode === 'shuffle' ? 'sequence' : 'shuffle';
      savePreferences();
      render();
    }

    function handleSeek(event) {
      if (!Number.isFinite(audio.duration) || audio.duration <= 0) return;
      const fraction = clampNumber(Number(event.target.value) / 1000, 0, 1, 0);
      audio.currentTime = fraction * audio.duration;
      updateAudioTime();
    }

    function handleVolume(event) {
      state.volume = clampNumber(event.target.value, 0, 1, state.volume);
      audio.volume = state.volume;
      savePreferences();
      render();
    }

    function updateAudioTime() {
      state.currentTime = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
      state.duration = Number.isFinite(audio.duration) ? audio.duration : 0;
      render();
    }

    function resetAudioElementOnly() {
      try {
        audio.pause();
        audio.removeAttribute('src');
        audio.load();
      } catch (_error) {}
    }

    function resetAudioSource() {
      state.playGeneration += 1;
      state.caching = false;
      resetAudioElementOnly();
      releaseActiveObjectUrl();
      state.loadedTrackUrl = '';
      state.playing = false;
      state.currentTime = 0;
      state.duration = 0;
    }

    function mediaErrorText(media) {
      const name = state.tracks[state.index]?.name || '当前曲目';
      switch (media.error?.code) {
        case 1:
          return `“${name}”加载被中止。`;
        case 2:
          return `“${name}”发生网络错误或链接失效。`;
        case 3:
          return `“${name}”无法解码，文件可能损坏。`;
        case 4:
          return `“${name}”的地址或音频格式不受支持。`;
        default:
          return `“${name}”发生未知播放错误。`;
      }
    }

    function setExpanded(expanded) {
      if (state.destroyed) return;
      if (expanded) {
        if (state.closing) {
          clearCloseFallbackTimer();
          state.closing = false;
          delete ui.root.dataset.closing;
          return;
        }
        if (state.expanded) return;
        swapExpandedView(true);
        return;
      }
      if (!state.expanded || state.closing) return;
      delete ui.root.dataset.opening;
      if (prefersReducedMotion()) {
        swapExpandedView(false);
        return;
      }
      state.closing = true;
      ui.root.dataset.closing = 'true';
      state.closeFallbackTimer = hostWindow.setTimeout(finishClosingAnimation, 280);
    }

    function finishClosingAnimation() {
      if (state.destroyed || !state.closing) return;
      clearCloseFallbackTimer();
      state.closing = false;
      delete ui.root.dataset.closing;
      swapExpandedView(false);
    }

    function clearCloseFallbackTimer() {
      if (!state.closeFallbackTimer) return;
      hostWindow.clearTimeout(state.closeFallbackTimer);
      state.closeFallbackTimer = 0;
    }

    function prefersReducedMotion() {
      return typeof hostWindow.matchMedia === 'function'
        && hostWindow.matchMedia('(prefers-reduced-motion: reduce)').matches;
    }

    function swapExpandedView(expanded) {
      const source = expanded ? ui.launcher : ui.panel;
      const sourceRect = source.getBoundingClientRect();
      const centerX = sourceRect.left + sourceRect.width / 2;
      const centerY = sourceRect.top + sourceRect.height / 2;
      ui.root.dataset.positioning = 'true';
      delete ui.root.dataset.opening;
      state.expanded = expanded;
      ui.launcher.hidden = expanded;
      ui.panel.hidden = !expanded;
      ui.launcher.setAttribute('aria-expanded', String(expanded));
      hostWindow.requestAnimationFrame(() => {
        const target = expanded ? ui.panel : ui.launcher;
        const targetRect = target.getBoundingClientRect();
        state.x = centerX - targetRect.width / 2;
        state.y = centerY - targetRect.height / 2;
        applyPosition();
        clampPosition();
        delete ui.root.dataset.positioning;
        if (expanded) {
          if (!prefersReducedMotion()) ui.root.dataset.opening = 'true';
          scheduleTrackOverflowUpdate();
          ui.playButton.focus({ preventScroll: true });
        } else {
          ui.launcher.focus({ preventScroll: true });
        }
      });
    }

    function setPlaylistExpanded(expanded) {
      if (state.destroyed || state.playlistExpanded === expanded) return;
      state.playlistExpanded = expanded;
      render();
      if (expanded) scheduleTrackOverflowUpdate();
      hostWindow.requestAnimationFrame(() => clampPosition());
    }

    function beginDrag(event, source) {
      if (state.drag || !event.isPrimary) return;
      if (source === 'panel' && event.target.closest('button, input')) return;
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      event.preventDefault();
      const rect = ui.root.getBoundingClientRect();
      state.drag = {
        source,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        startLeft: rect.left,
        startTop: rect.top,
        moved: false,
        target: event.currentTarget,
      };
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch (_error) {}
      onDragSession(hostWindow, 'pointermove', moveDrag);
      onDragSession(hostWindow, 'pointerup', finishDrag);
      onDragSession(hostWindow, 'pointercancel', cancelDrag);
      ui.root.dataset.dragging = 'true';
    }

    const dragDisposers = [];

    function onDragSession(target, type, listener) {
      target.addEventListener(type, listener);
      dragDisposers.push(() => target.removeEventListener(type, listener));
    }

    function moveDrag(event) {
      const drag = state.drag;
      if (!drag || event.pointerId !== drag.pointerId) return;
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      if (Math.hypot(dx, dy) >= DRAG_THRESHOLD) drag.moved = true;
      if (!drag.moved) return;
      event.preventDefault();
      state.x = drag.startLeft + dx;
      state.y = drag.startTop + dy;
      applyPosition();
      clampPosition(false);
    }

    function finishDrag(event) {
      const drag = state.drag;
      if (!drag || event.pointerId !== drag.pointerId) return;
      endDrag(false);
    }

    function cancelDrag(event) {
      const drag = state.drag;
      if (!drag || event.pointerId !== drag.pointerId) return;
      endDrag(true);
    }

    function endDrag(cancelled) {
      const drag = state.drag;
      if (!drag) return;
      if (drag.source === 'launcher' && drag.moved) state.suppressLauncherClick = true;
      try {
        drag.target.releasePointerCapture(drag.pointerId);
      } catch (_error) {}
      while (dragDisposers.length) {
        try {
          dragDisposers.pop()();
        } catch (_error) {}
      }
      state.drag = null;
      delete ui.root.dataset.dragging;
      if (!cancelled) {
        clampPosition();
        savePreferences();
      }
    }

    function restorePosition() {
      const viewport = visibleViewport();
      state.x = Number.isFinite(state.x) ? state.x : viewport.x + viewport.width - 68;
      state.y = Number.isFinite(state.y) ? state.y : viewport.y + Math.max(16, viewport.height - 180);
      applyPosition();
      hostWindow.requestAnimationFrame(() => clampPosition());
    }

    function visibleViewport() {
      const viewport = hostWindow.visualViewport;
      if (viewport) {
        return {
          x: viewport.offsetLeft,
          y: viewport.offsetTop,
          width: viewport.width,
          height: viewport.height,
        };
      }
      return { x: 0, y: 0, width: hostWindow.innerWidth, height: hostWindow.innerHeight };
    }

    function applyPosition() {
      ui.root.style.left = `${Math.round(state.x)}px`;
      ui.root.style.top = `${Math.round(state.y)}px`;
    }

    function clampPosition(shouldPersist = true) {
      if (state.destroyed) return;
      const viewport = visibleViewport();
      const rect = ui.root.getBoundingClientRect();
      const minX = viewport.x + EDGE_GAP;
      const minY = viewport.y + EDGE_GAP;
      const maxX = Math.max(minX, viewport.x + viewport.width - rect.width - EDGE_GAP);
      const maxY = Math.max(minY, viewport.y + viewport.height - rect.height - EDGE_GAP);
      state.x = clampNumber(state.x, minX, maxX, minX);
      state.y = clampNumber(state.y, minY, maxY, minY);
      applyPosition();
      if (shouldPersist) savePreferences();
    }

    function scheduleClamp() {
      if (state.resizeFrame || state.destroyed) return;
      state.resizeFrame = hostWindow.requestAnimationFrame(() => {
        state.resizeFrame = 0;
        clampPosition();
        scheduleTrackOverflowUpdate();
      });
    }

    function renderTrackList() {
      ui.trackList.replaceChildren();
      if (!state.tracks.length) return;
      const fragment = hostDocument.createDocumentFragment();
      state.tracks.forEach((track, index) => {
        const item = element('li', 'op74-fmp-track-item');
        const button = element('button', 'op74-fmp-track-button');
        const number = element('span', 'op74-fmp-track-number');
        const nameWindow = element('span', 'op74-fmp-track-name-window');
        const name = element('span', 'op74-fmp-track-name');
        const duration = element('span', 'op74-fmp-track-duration');
        button.type = 'button';
        button.dataset.trackIndex = String(index);
        number.textContent = String(index + 1).padStart(2, '0');
        name.textContent = track.name;
        duration.textContent = track.durationLabel;
        nameWindow.appendChild(name);
        button.title = track.album ? `${track.name} — ${track.album}` : track.name;
        button.setAttribute('aria-label', `播放 ${track.name}`);
        button.append(number, nameWindow, duration);
        item.appendChild(button);
        fragment.appendChild(item);
      });
      ui.trackList.appendChild(fragment);
      scheduleTrackOverflowUpdate();
    }

    function scheduleTrackOverflowUpdate() {
      if (state.trackMeasureFrame || state.destroyed) return;
      state.trackMeasureFrame = hostWindow.requestAnimationFrame(() => {
        state.trackMeasureFrame = 0;
        ui.trackList.querySelectorAll('.op74-fmp-track-button').forEach((button) => {
          const nameWindow = button.querySelector('.op74-fmp-track-name-window');
          const name = button.querySelector('.op74-fmp-track-name');
          if (!nameWindow || !name || nameWindow.clientWidth <= 0) return;
          const shift = Math.max(0, Math.ceil(name.scrollWidth - nameWindow.clientWidth));
          button.classList.toggle('is-overflowing', shift > 1);
          button.style.setProperty('--op74-fmp-track-shift', `${shift}px`);
          button.style.setProperty(
            '--op74-fmp-track-duration',
            `${Math.min(18, Math.max(6, 5 + shift / 18))}s`,
          );
        });
      });
    }

    function render() {
      if (state.destroyed) return;
      const currentTrack = state.tracks[state.index];
      ui.nowTitle.textContent = currentTrack ? currentTrack.name : '—';
      ui.nowAlbum.textContent = currentTrack?.album || '';
      ui.nowTitle.title = currentTrack
        ? (currentTrack.album ? `${currentTrack.name} — ${currentTrack.album}` : currentTrack.name)
        : '';
      renderArtwork();
      setButtonIcon(ui.playButton, state.playing ? 'pause' : 'play');
      ui.playButton.setAttribute('aria-label', state.playing ? '暂停播放' : '开始播放');
      setButtonIcon(ui.modeButton, state.mode === 'shuffle' ? 'shuffle' : 'sequence');
      ui.modeButton.setAttribute(
        'aria-label',
        state.mode === 'shuffle' ? '当前随机播放，切换为顺序播放' : '当前顺序播放，切换为随机播放',
      );
      ui.modeButton.setAttribute('aria-pressed', String(state.mode === 'shuffle'));
      const disabled = state.loading || !state.tracks.length;
      ui.previousButton.disabled = disabled;
      ui.playButton.disabled = disabled;
      ui.nextButton.disabled = disabled;
      ui.playlistButton.disabled = disabled;
      ui.playlistButton.setAttribute('aria-expanded', String(state.playlistExpanded));
      ui.playlistButton.setAttribute('aria-pressed', String(state.playlistExpanded));
      ui.playlistButton.setAttribute(
        'aria-label',
        state.playlistExpanded ? '收起播放列表' : '展开播放列表',
      );
      ui.playlistButton.title = state.playlistExpanded ? '收起播放列表' : '展开播放列表';
      ui.trackList.classList.toggle('is-expanded', state.playlistExpanded);
      ui.trackList.setAttribute('aria-hidden', String(!state.playlistExpanded));
      if (state.playlistExpanded) {
        ui.trackList.removeAttribute('inert');
      } else {
        ui.trackList.setAttribute('inert', '');
      }
      ui.progress.disabled = !state.duration;
      ui.progress.value = state.duration
        ? String(Math.round(clampNumber(state.currentTime / state.duration, 0, 1, 0) * 1000))
        : '0';
      ui.timeDisplay.textContent = `${formatTime(state.currentTime)}/${formatTime(state.duration)}`;
      ui.volume.value = String(state.volume);
      ui.volume.setAttribute('aria-valuetext', `${Math.round(state.volume * 100)}%`);

      let statusText = '';
      let statusKind = 'info';
      if (state.loading) {
        statusText = '正在加载歌单…';
      } else if (state.error) {
        statusText = state.error;
        statusKind = 'error';
      } else if (state.caching) {
        statusText = '正在读取本地缓存…';
      } else if (state.waiting) {
        statusText = '正在缓冲音频…';
      } else if (state.notice) {
        statusText = state.notice;
        statusKind = state.noticeKind;
      }
      ui.status.textContent = statusText;
      ui.status.dataset.kind = statusKind;
      ui.retryButton.hidden = !state.error;
      ui.statusRow.hidden = !statusText && !state.error;

      ui.trackList.querySelectorAll('button[data-track-index]').forEach((button) => {
        const trackIndex = Number(button.dataset.trackIndex);
        const active = trackIndex === state.index;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-current', active ? 'true' : 'false');
        button.tabIndex = state.playlistExpanded ? 0 : -1;
        const duration = button.querySelector('.op74-fmp-track-duration');
        if (duration) {
          duration.textContent = active && state.duration
            ? formatTime(state.duration)
            : state.tracks[trackIndex]?.durationLabel || '';
        }
      });
    }

    function renderArtwork() {
      const cover = config.headerImage;
      if (ui.albumCover.dataset.source === cover) return;
      ui.albumCover.dataset.source = cover;

      if (!cover) {
        ui.albumCover.removeAttribute('src');
        ui.albumCover.alt = '';
        ui.albumCover.hidden = true;
        ui.albumFallback.hidden = false;
        return;
      }

      ui.albumCover.hidden = true;
      ui.albumFallback.hidden = false;
      ui.albumCover.alt = '播放器横幅图';
      ui.albumCover.src = cover;
    }

    function setNotice(text, kind) {
      state.notice = String(text || '');
      state.noticeKind = kind || 'info';
    }

    function formatTime(seconds) {
      if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
      const minutes = Math.floor(seconds / 60);
      const remainder = Math.floor(seconds % 60);
      return `${minutes}:${String(remainder).padStart(2, '0')}`;
    }

    function stringOrFallback(value, fallback, maxLength) {
      const text = typeof value === 'string' ? value.trim() : '';
      return (text || fallback).slice(0, maxLength);
    }

    function clampNumber(value, min, max, fallback) {
      const number = Number(value);
      if (!Number.isFinite(number)) return fallback;
      return Math.min(Math.max(number, min), max);
    }

    function finiteOrNull(value) {
      const number = Number(value);
      return Number.isFinite(number) ? number : null;
    }

    function destroy() {
      if (state.destroyed) return;
      state.destroyed = true;
      state.playlistGeneration += 1;
      state.loadController?.abort();
      state.loadController = null;
      if (state.resizeFrame) {
        hostWindow.cancelAnimationFrame(state.resizeFrame);
        state.resizeFrame = 0;
      }
      if (state.trackMeasureFrame) {
        hostWindow.cancelAnimationFrame(state.trackMeasureFrame);
        state.trackMeasureFrame = 0;
      }
      for (const { controller } of cacheJobs.values()) controller.abort();
      cacheJobs.clear();
      clearCloseFallbackTimer();
      endDrag(true);
      while (disposers.length) {
        try {
          disposers.pop()();
        } catch (error) {
          console.warn('[Op.74 悬浮音乐播放器] 事件清理失败。', error);
        }
      }
      resetAudioSource();
      ui.root.remove();
      style.remove();
      if (hostWindow[RUNTIME_KEY] === runtime) delete hostWindow[RUNTIME_KEY];
      console.info('[Op.74 悬浮音乐播放器] 已卸载');
    }
  }

  function cssText() {
    return `
#${ROOT_ID},
#${ROOT_ID} * {
  box-sizing: border-box;
}

#${ROOT_ID} {
  --op74-fmp-shell: #25272a;
  --op74-fmp-shell-deep: #111315;
  --op74-fmp-metal: #d7d3c7;
  --op74-fmp-ink: #f2efe6;
  --op74-fmp-muted: #aaa99f;
  --op74-fmp-line: #4d4f50;
  --op74-fmp-divider: #7b7e80;
  --op74-fmp-gold: #d5aa55;
  --op74-fmp-star: #f3c849;
  --op74-fmp-red: #a52420;
  --op74-fmp-danger: #ff9a78;
  position: fixed;
  z-index: 99999;
  left: 16px;
  top: 16px;
  color: var(--op74-fmp-ink);
  font: 14px/1.4 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  user-select: none;
  -webkit-tap-highlight-color: transparent;
}

#${ROOT_ID}[data-dragging="true"] {
  cursor: grabbing;
}

#${ROOT_ID} button,
#${ROOT_ID} input {
  font: inherit;
}

#${ROOT_ID} button:focus-visible,
#${ROOT_ID} input:focus-visible {
  outline: 3px solid rgba(243, 200, 73, 0.72);
  outline-offset: 3px;
}

.op74-fmp-sr-only {
  position: absolute !important;
  width: 1px !important;
  height: 1px !important;
  padding: 0 !important;
  margin: -1px !important;
  overflow: hidden !important;
  clip: rect(0, 0, 0, 0) !important;
  white-space: nowrap !important;
  border: 0 !important;
}

.op74-fmp-launcher {
  width: 62px;
  height: 62px;
  padding: 0;
  overflow: hidden;
  border: 2px solid #090b0d;
  border-radius: 50%;
  background: #111824;
  color: var(--op74-fmp-ink);
  box-shadow:
    0 0 0 2px var(--op74-fmp-gold),
    0 0 0 5px rgba(17, 24, 36, 0.94),
    0 9px 22px rgba(0, 0, 0, 0.38),
    inset 0 0 14px rgba(213, 170, 85, 0.18);
  cursor: grab;
  touch-action: none;
  transition: transform 160ms ease, filter 160ms ease;
}

.op74-fmp-launcher:hover {
  filter: brightness(1.08);
  transform: translateY(-1px);
}

.op74-fmp-launcher:active {
  cursor: grabbing;
  transform: translateY(1px) scale(0.98);
}

.op74-fmp-launcher-mark {
  display: block;
  width: 100%;
  height: 100%;
}

.op74-fmp-star-rays line {
  stroke: #ffffff;
  stroke-width: 0.78;
  opacity: 0.82;
}

.op74-fmp-panel {
  position: relative;
  width: min(340px, calc(100vw - 16px));
  height: auto;
  max-height: min(600px, calc(100vh - 16px));
  max-height: min(600px, calc(100dvh - 16px));
  overflow: hidden;
  border: 1px solid #57595b;
  border-radius: 24px 24px 12px 12px;
  background:
    radial-gradient(circle at 50% -10%, rgba(213, 170, 85, 0.15), transparent 42%),
    linear-gradient(155deg, #242629 0%, #17191b 72%);
  color: var(--op74-fmp-ink);
  box-shadow:
    0 20px 48px rgba(0, 0, 0, 0.46),
    inset 1px 0 rgba(255, 255, 255, 0.09),
    inset -1px 0 rgba(0, 0, 0, 0.65);
}

.op74-fmp-panel[hidden],
.op74-fmp-launcher[hidden] {
  display: none !important;
}

#${ROOT_ID}[data-positioning="true"] .op74-fmp-panel,
#${ROOT_ID}[data-positioning="true"] .op74-fmp-launcher {
  visibility: hidden !important;
}

#${ROOT_ID}[data-opening="true"] .op74-fmp-panel {
  transform-origin: center;
  animation: op74-fmp-panel-open 220ms cubic-bezier(0.16, 1, 0.3, 1) both;
}

#${ROOT_ID}[data-closing="true"] .op74-fmp-panel {
  pointer-events: none;
  transform-origin: center;
  animation: op74-fmp-panel-close 200ms cubic-bezier(0.7, 0, 0.84, 0) both;
}

@keyframes op74-fmp-panel-open {
  from {
    opacity: 0;
    transform: scale(0.72);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}

@keyframes op74-fmp-panel-close {
  from {
    opacity: 1;
    transform: scale(1);
  }
  to {
    opacity: 0;
    transform: scale(0.72);
  }
}

.op74-fmp-main {
  display: flex;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
  gap: 7px;
  width: 100%;
  height: auto;
  max-height: min(598px, calc(100vh - 18px));
  max-height: min(598px, calc(100dvh - 18px));
  padding: 12px;
  overflow: hidden;
  border-radius: inherit;
  background: transparent;
  box-shadow: none;
  position: relative;
  z-index: 2;
}

.op74-fmp-album-stage {
  position: relative;
  flex: 0 0 auto;
  cursor: grab;
  touch-action: none;
}

.op74-fmp-album-stage:active {
  cursor: grabbing;
}

.op74-fmp-album-frame {
  position: relative;
  width: 100%;
  margin: 0 auto;
  aspect-ratio: 16 / 7;
  overflow: hidden;
  border: 1px solid #66686a;
  border-radius: 9px;
  background:
    linear-gradient(135deg, rgba(213, 170, 85, 0.16), transparent 45%),
    #10151e;
  box-shadow:
    0 0 0 3px #151719,
    0 7px 18px rgba(0, 0, 0, 0.38),
    inset 0 0 28px rgba(0, 0, 0, 0.45);
}

.op74-fmp-album-cover,
.op74-fmp-album-fallback {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}

.op74-fmp-album-cover {
  z-index: 1;
  display: block;
  object-fit: cover;
}

.op74-fmp-album-cover[hidden],
.op74-fmp-album-fallback[hidden] {
  display: none !important;
}

.op74-fmp-album-fallback {
  display: grid;
  place-items: center;
  background:
    repeating-linear-gradient(90deg, transparent 0 18px, rgba(255,255,255,0.022) 18px 19px),
    #111824;
}

.op74-fmp-cover-mark {
  width: min(58%, 150px);
  height: min(88%, 150px);
  filter: drop-shadow(0 8px 16px rgba(0, 0, 0, 0.35));
}

.op74-fmp-overlay-close {
  position: absolute;
  z-index: 3;
  top: 8px;
  right: 8px;
  width: 34px;
  min-width: 34px;
  height: 34px;
  min-height: 34px;
  padding: 8px;
  border-color: rgba(255, 255, 255, 0.22);
  background: rgba(12, 13, 14, 0.72);
  color: #f1f1ed;
  backdrop-filter: blur(4px);
}

.op74-fmp-meta {
  min-width: 0;
  padding: 0 3px;
}

.op74-fmp-now-title,
.op74-fmp-now-album {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.op74-fmp-now-title {
  color: #f4f1e8;
  font-size: 14px;
  font-weight: 700;
}

.op74-fmp-now-album {
  min-height: 15px;
  color: var(--op74-fmp-muted);
  font-size: 11px;
}

.op74-fmp-controls {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  align-items: center;
  gap: 5px;
  padding: 5px 8px;
  border: 1px solid #555759;
  border-radius: 999px;
  background: #202224;
  box-shadow: inset 0 1px rgba(255, 255, 255, 0.04);
}

.op74-fmp-transport {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 5px;
  min-height: 24px;
  padding: 3px 4px;
  border: 1px solid #090b0d;
  border-radius: 2px;
  background: #151719;
  box-shadow: inset 0 1px 5px rgba(0, 0, 0, 0.65);
}

.op74-fmp-progress,
.op74-fmp-volume-row input {
  appearance: none;
  -webkit-appearance: none;
  min-width: 0;
  width: 100%;
  height: 14px;
  margin: 0;
  padding: 0 !important;
  border: 0 !important;
  border-radius: 0 !important;
  background: transparent !important;
  background-color: transparent !important;
  background-image: none !important;
  box-shadow: none !important;
  accent-color: var(--op74-fmp-gold);
  cursor: pointer;
}

.op74-fmp-time-display {
  color: var(--op74-fmp-muted);
  font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
  font-variant-numeric: tabular-nums;
  font-size: 9px;
  letter-spacing: -0.035em;
}

.op74-fmp-volume-row {
  display: grid;
  grid-template-columns: 18px minmax(0, 1fr);
  align-items: center;
  gap: 4px;
  min-height: 24px;
  padding: 3px 4px;
  border: 1px solid #090b0d;
  border-radius: 2px;
  background: #151719;
  box-shadow: inset 0 1px 5px rgba(0, 0, 0, 0.65);
}

.op74-fmp-volume-icon {
  display: grid;
  width: 18px;
  height: 18px;
  place-items: center;
  color: var(--op74-fmp-metal);
}

.op74-fmp-volume-icon .op74-fmp-icon {
  width: 16px;
  height: 16px;
}

.op74-fmp-progress::-webkit-slider-runnable-track,
.op74-fmp-volume-row input::-webkit-slider-runnable-track {
  height: 5px;
  border: 1px solid #060708;
  border-radius: 6px;
  background: #34373a !important;
  box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.7);
}

.op74-fmp-progress::-webkit-slider-thumb,
.op74-fmp-volume-row input::-webkit-slider-thumb {
  width: 12px;
  height: 12px;
  margin-top: -4px;
  -webkit-appearance: none;
  border: 1px solid #17130b;
  border-radius: 50%;
  background: var(--op74-fmp-gold);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.55);
}

.op74-fmp-progress::-moz-range-track,
.op74-fmp-volume-row input::-moz-range-track {
  height: 5px;
  border: 1px solid #060708;
  border-radius: 6px;
  background: #34373a;
  box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.7);
}

.op74-fmp-progress::-moz-range-thumb,
.op74-fmp-volume-row input::-moz-range-thumb {
  width: 12px;
  height: 12px;
  border: 1px solid #17130b;
  border-radius: 50%;
  background: var(--op74-fmp-gold);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.55);
}

.op74-fmp-status-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 6px;
  min-height: 0;
}

.op74-fmp-status-row[hidden] {
  display: none !important;
}

.op74-fmp-status {
  min-width: 0;
  color: var(--op74-fmp-muted);
  overflow-wrap: anywhere;
  font-size: 9px;
}

.op74-fmp-status[data-kind="error"] {
  color: var(--op74-fmp-danger);
}

.op74-fmp-retry {
  display: grid;
  width: 28px;
  height: 28px;
  padding: 4px;
  place-items: center;
  border: 1px solid #6d6c66;
  border-radius: 3px;
  background: #303236;
  color: var(--op74-fmp-ink);
  cursor: pointer;
}

.op74-fmp-retry[hidden] {
  display: none !important;
}

.op74-fmp-track-list {
  min-height: 0;
  max-height: 0;
  flex: 0 0 auto;
  margin: -7px 0 0;
  padding: 0 3px 0 0;
  overflow-y: auto;
  border: 0;
  border-radius: 9px;
  background: rgba(12, 13, 14, 0.38);
  box-shadow: none;
  overscroll-behavior: contain;
  scrollbar-color: var(--op74-fmp-divider) #151719;
  scrollbar-width: thin;
  list-style: none;
  opacity: 0;
  visibility: hidden;
  transform: translateY(-10px);
  pointer-events: none;
  transition:
    max-height 340ms cubic-bezier(0.16, 1, 0.3, 1),
    margin 300ms ease,
    padding 300ms ease,
    opacity 220ms ease,
    transform 300ms cubic-bezier(0.16, 1, 0.3, 1),
    visibility 0s linear 340ms;
}

.op74-fmp-track-list.is-expanded {
  max-height: 220px;
  margin-top: 0;
  padding-top: 3px;
  padding-bottom: 3px;
  opacity: 1;
  visibility: visible;
  transform: translateY(0);
  pointer-events: auto;
  transition-delay: 0s;
}

.op74-fmp-track-list::-webkit-scrollbar {
  width: 7px;
}

.op74-fmp-track-list::-webkit-scrollbar-track {
  background: #151719;
}

.op74-fmp-track-list::-webkit-scrollbar-thumb {
  border: 1px solid #151719;
  border-radius: 8px;
  background: var(--op74-fmp-divider);
}

.op74-fmp-track-item + .op74-fmp-track-item {
  margin-top: 0;
}

.op74-fmp-track-button {
  display: grid;
  grid-template-columns: 30px minmax(0, 1fr) auto;
  align-items: center;
  gap: 6px;
  width: 100%;
  min-height: 38px;
  padding: 5px 10px 5px 6px;
  overflow: hidden;
  border: 0;
  border-bottom: 1px solid #343638;
  border-radius: 0;
  background: transparent;
  color: #d6d7d8;
  text-align: left;
  white-space: nowrap;
  cursor: pointer;
  font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-size: 12px;
}

.op74-fmp-track-button:hover {
  background: #292b2d;
}

.op74-fmp-track-button.is-active {
  border-bottom-color: transparent;
  border-radius: 8px;
  background: var(--op74-fmp-red);
  color: #ffffff;
  font-weight: 650;
}

.op74-fmp-track-number,
.op74-fmp-track-duration {
  color: #9ea0a2;
  font-variant-numeric: tabular-nums;
  font-size: 11px;
}

.op74-fmp-track-number {
  text-align: center;
}

.op74-fmp-track-duration {
  min-width: 31px;
  text-align: right;
}

.op74-fmp-track-button.is-active .op74-fmp-track-number,
.op74-fmp-track-button.is-active .op74-fmp-track-duration {
  color: #f7d7d4;
}

.op74-fmp-track-name-window {
  min-width: 0;
  overflow: hidden;
}

.op74-fmp-track-name {
  display: inline-block;
  min-width: max-content;
  pointer-events: none;
}

.op74-fmp-track-button.is-overflowing:hover .op74-fmp-track-name,
.op74-fmp-track-button.is-overflowing:focus-visible .op74-fmp-track-name {
  animation: op74-fmp-track-marquee var(--op74-fmp-track-duration, 8s) ease-in-out infinite alternate;
}

@keyframes op74-fmp-track-marquee {
  from { transform: translateX(0); }
  to { transform: translateX(calc(-1 * var(--op74-fmp-track-shift, 0px))); }
}

.op74-fmp-key {
  display: grid;
  width: 38px;
  min-width: 38px;
  height: 38px;
  min-height: 38px;
  padding: 8px;
  place-items: center;
  border: 1px solid transparent;
  border-radius: 50%;
  background: transparent;
  color: #d7d8d9;
  box-shadow: none;
  cursor: pointer;
  transform: none;
  transition: transform 90ms ease, background 120ms ease, color 120ms ease;
  pointer-events: auto;
}

.op74-fmp-controls .op74-fmp-key {
  justify-self: center;
}

.op74-fmp-key:hover:not(:disabled),
.op74-fmp-retry:hover {
  background: #343638;
  color: #ffffff;
}

.op74-fmp-key:active:not(:disabled) {
  transform: translateY(2px);
  box-shadow: none;
}

.op74-fmp-key[aria-pressed="true"] {
  border-color: var(--op74-fmp-gold);
  color: var(--op74-fmp-gold);
  box-shadow: none;
}

.op74-fmp-primary-key {
  width: 44px;
  min-width: 44px;
  height: 44px;
  min-height: 44px;
  padding: 10px;
  background: var(--op74-fmp-gold);
  color: #151719;
}

.op74-fmp-primary-key:hover:not(:disabled) {
  background: #efd77e;
  color: #111315;
}

.op74-fmp-icon {
  display: block;
  width: 100%;
  height: 100%;
  pointer-events: none;
}

#${ROOT_ID} button:disabled,
#${ROOT_ID} input:disabled {
  cursor: not-allowed;
  opacity: 0.42;
}

@media (max-width: 360px) {
  .op74-fmp-panel {
    width: calc(100vw - 16px);
  }
}

@media (max-height: 480px) {
  .op74-fmp-album-frame {
    aspect-ratio: 16 / 5;
  }

  .op74-fmp-track-list.is-expanded {
    max-height: 140px;
  }
}

@media (prefers-reduced-motion: reduce) {
  #${ROOT_ID},
  #${ROOT_ID} * {
    scroll-behavior: auto !important;
    transition: none !important;
    animation: none !important;
  }
}
`;
  }
})();
