/* =====================================================
   Stock Chart App
   - Multi-proxy fallback + timeout for reliability
   - MA5 / MA20 / MA60 moving average overlays
   - Market indices ticker bar
   - Download chart as PNG
   ===================================================== */

// ── Proxy config ──────────────────────────────────────
// Tried in order; each attempt aborted after 8 s
const PROXIES = [
  {
    make: url => `https://corsproxy.io/?${encodeURIComponent(url)}`,
    parse: res => res.json(),
  },
  {
    make: url => `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`,
    parse: async res => { const j = await res.json(); return JSON.parse(j.contents); },
  },
  {
    make: url => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
    parse: res => res.json(),
  },
];

async function yahooFetch(endpoint, timeoutMs = 8000) {
  const base = 'https://query1.finance.yahoo.com/v8/finance/' + endpoint;
  let lastErr;
  for (const proxy of PROXIES) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(proxy.make(base), { signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await proxy.parse(res);
      if (data?.chart?.error) throw new Error(data.chart.error.description || 'Yahoo error');
      return data;
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
    }
  }
  throw lastErr || new Error('All proxies failed');
}

// ── DOM refs ──────────────────────────────────────────
const symbolInput  = document.getElementById('symbolInput');
const searchBtn    = document.getElementById('searchBtn');
const stockInfo    = document.getElementById('stockInfo');
const chartSection = document.getElementById('chartSection');
const chartLoading = document.getElementById('chartLoading');
const chartError   = document.getElementById('chartError');
const addWatchBtn  = document.getElementById('addToWatchlist');
const watchGrid    = document.getElementById('watchlistGrid');
const toastEl      = document.getElementById('toast');

// ── State ──────────────────────────────────────────────
let chartInstance = null;
let currentSymbol = '';
let currentPeriod = '1mo';
let currentPoints = [];
const maEnabled   = { 5: false, 20: false, 60: false };

// ── Quick picks ───────────────────────────────────────
document.querySelectorAll('.quick-btn').forEach(btn => {
  btn.addEventListener('click', () => search(btn.dataset.symbol));
});

// ── Period buttons ────────────────────────────────────
document.querySelectorAll('.period-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.period-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentPeriod = btn.dataset.period;
    if (currentSymbol) loadChart(currentSymbol, currentPeriod);
  });
});

// ── MA buttons ────────────────────────────────────────
document.querySelectorAll('.ma-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const p = Number(btn.dataset.ma);
    maEnabled[p] = !maEnabled[p];
    btn.classList.toggle('active', maEnabled[p]);
    if (currentPoints.length) renderChart(currentPoints, currentPeriod, currentSymbol);
  });
});

// ── Download button ───────────────────────────────────
document.getElementById('downloadChart').addEventListener('click', downloadChart);

// ── Retry button ──────────────────────────────────────
document.getElementById('retryBtn').addEventListener('click', () => {
  if (currentSymbol) loadChart(currentSymbol, currentPeriod);
});

// ── Search ────────────────────────────────────────────
searchBtn.addEventListener('click', () => search(symbolInput.value.trim()));
symbolInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') search(symbolInput.value.trim());
});

async function search(symbol) {
  if (!symbol) return;
  symbol = symbol.toUpperCase();
  symbolInput.value = symbol;
  currentSymbol     = symbol;
  currentPoints     = [];

  stockInfo.style.display  = 'none';
  chartSection.style.display = 'none';
  addWatchBtn.style.display  = 'none';

  searchBtn.disabled    = true;
  searchBtn.textContent = '查詢中…';

  try {
    await Promise.all([loadQuote(symbol), loadChart(symbol, currentPeriod)]);
    stockInfo.style.display    = '';
    chartSection.style.display = '';
    addWatchBtn.style.display  = '';
  } finally {
    searchBtn.disabled    = false;
    searchBtn.textContent = '查詢';
  }
}

// ── Quote ─────────────────────────────────────────────
async function loadQuote(symbol) {
  try {
    const data = await yahooFetch(`chart/${symbol}?range=1d&interval=1d`);
    const meta = data?.chart?.result?.[0]?.meta;
    if (!meta) throw new Error('no meta');

    const price  = meta.regularMarketPrice ?? 0;
    const prev   = meta.chartPreviousClose ?? meta.previousClose ?? price;
    const change = price - prev;
    const pct    = prev ? (change / prev) * 100 : 0;
    const up     = change >= 0;

    document.getElementById('stockName').textContent   = meta.longName || meta.shortName || symbol;
    document.getElementById('stockSymbol').textContent = symbol;
    document.getElementById('stockPrice').textContent  = fmt(price, meta.currency);

    const chEl = document.getElementById('priceChange');
    chEl.textContent = `${up ? '+' : ''}${fmt(change, meta.currency)} (${up ? '+' : ''}${pct.toFixed(2)}%)`;
    chEl.className   = 'price-change ' + (up ? 'up' : 'down');

    document.getElementById('infoOpen').textContent   = fmt(meta.regularMarketOpen,    meta.currency);
    document.getElementById('infoHigh').textContent   = fmt(meta.regularMarketDayHigh, meta.currency);
    document.getElementById('infoLow').textContent    = fmt(meta.regularMarketDayLow,  meta.currency);
    document.getElementById('infoVolume').textContent = fmtVol(meta.regularMarketVolume);
    document.getElementById('info52High').textContent = fmt(meta.fiftyTwoWeekHigh,     meta.currency);
    document.getElementById('info52Low').textContent  = fmt(meta.fiftyTwoWeekLow,      meta.currency);
  } catch (e) {
    console.warn('loadQuote error', e);
  }
}

// ── Chart data ────────────────────────────────────────
const PERIOD_MAP = {
  '1d':  { range: '1d',  interval: '5m'  },
  '5d':  { range: '5d',  interval: '30m' },
  '1mo': { range: '1mo', interval: '1d'  },
  '3mo': { range: '3mo', interval: '1d'  },
  '6mo': { range: '6mo', interval: '1wk' },
  '1y':  { range: '1y',  interval: '1wk' },
  '5y':  { range: '5y',  interval: '1mo' },
};

async function loadChart(symbol, period) {
  chartLoading.classList.add('show');
  chartError.style.display = 'none';
  try {
    const { range, interval } = PERIOD_MAP[period] ?? PERIOD_MAP['1mo'];
    const data   = await yahooFetch(`chart/${symbol}?range=${range}&interval=${interval}`);
    const result = data?.chart?.result?.[0];
    if (!result) throw new Error('no result');

    const ts = result.timestamp ?? [];
    const q  = result.indicators?.quote?.[0] ?? {};

    const points = ts
      .map((t, i) => ({
        x: new Date(t * 1000),
        o: q.open?.[i],
        h: q.high?.[i],
        l: q.low?.[i],
        c: q.close?.[i],
      }))
      .filter(p => p.c != null);

    if (!points.length) throw new Error('empty data');
    currentPoints = points;
    renderChart(points, period, symbol);
  } catch (e) {
    console.warn('loadChart error', e);
    chartError.style.display = '';
  } finally {
    chartLoading.classList.remove('show');
  }
}

// ── Moving averages ───────────────────────────────────
function calcMA(points, period) {
  return points.map((p, i) => {
    if (i < period - 1) return { x: p.x, y: null };
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += points[j].c;
    return { x: p.x, y: +(sum / period).toFixed(4) };
  });
}

const MA_CONFIG = [
  { period: 5,  color: '#f0883e', label: 'MA5'  },
  { period: 20, color: '#79c0ff', label: 'MA20' },
  { period: 60, color: '#bc8cff', label: 'MA60' },
];

// ── Render chart ──────────────────────────────────────
function renderChart(points, period, symbol) {
  const canvas = document.getElementById('stockChart');
  if (chartInstance) { chartInstance.destroy(); chartInstance = null; }

  const first = points[0]?.c ?? 0;
  const last  = points[points.length - 1]?.c ?? 0;
  const up    = last >= first;
  const color = up ? '#3fb950' : '#f85149';

  const timeUnit = ['1d','5d'].includes(period)     ? 'hour'
                 : ['1mo','3mo'].includes(period)    ? 'day'
                 : ['6mo','1y'].includes(period)     ? 'week' : 'month';

  const datasets = [{
    label: symbol,
    data: points.map(p => ({ x: p.x, y: p.c })),
    borderColor: color,
    backgroundColor: hexAlpha(color, .1),
    borderWidth: 2,
    pointRadius: 0,
    fill: true,
    tension: 0.3,
    order: 10,
  }];

  for (const ma of MA_CONFIG) {
    if (!maEnabled[ma.period]) continue;
    datasets.push({
      label: ma.label,
      data: calcMA(points, ma.period),
      borderColor: ma.color,
      borderWidth: 1.5,
      pointRadius: 0,
      fill: false,
      tension: 0.3,
      spanGaps: false,
      order: 1,
    });
  }

  const hasMA = datasets.length > 1;

  chartInstance = new Chart(canvas, {
    type: 'line',
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          display: hasMA,
          labels: { color: '#8b949e', boxWidth: 18, padding: 12, font: { size: 12 } },
        },
        tooltip: {
          backgroundColor: '#21262d',
          borderColor: '#30363d',
          borderWidth: 1,
          titleColor: '#8b949e',
          bodyColor: '#e6edf3',
          padding: 10,
          callbacks: {
            label: ctx => {
              const v = ctx.parsed.y;
              return v != null ? ` ${ctx.dataset.label}: ${v.toFixed(2)}` : '';
            },
          },
        },
      },
      scales: {
        x: {
          type: 'time',
          time: { unit: timeUnit },
          grid: { color: '#21262d' },
          ticks: { color: '#8b949e', maxTicksLimit: 8 },
        },
        y: {
          position: 'right',
          grid: { color: '#21262d' },
          ticks: { color: '#8b949e' },
        },
      },
    },
  });
}

// ── Download chart ────────────────────────────────────
function downloadChart() {
  if (!chartInstance) return;
  const src = chartInstance.canvas;
  const off = document.createElement('canvas');
  off.width  = src.width;
  off.height = src.height;
  const ctx = off.getContext('2d');
  ctx.fillStyle = '#161b22';
  ctx.fillRect(0, 0, off.width, off.height);
  ctx.drawImage(src, 0, 0);
  const a = document.createElement('a');
  a.download = `${currentSymbol || 'chart'}_${currentPeriod}.png`;
  a.href = off.toDataURL('image/png');
  a.click();
}

// ── Market ticker ─────────────────────────────────────
const TICKER_SYMBOLS = [
  { sym: '^GSPC',  name: 'S&P 500'  },
  { sym: '^IXIC',  name: 'NASDAQ'   },
  { sym: '^DJI',   name: '道瓊斯'   },
  { sym: '^TWII',  name: '台灣加權' },
  { sym: '^HSI',   name: '恆生'     },
  { sym: 'GC=F',   name: '黃金'     },
  { sym: 'CL=F',   name: '原油'     },
];

function tickId(sym) { return 'tick_' + sym.replace(/[^a-z0-9]/gi, '_'); }

async function loadMarketTicker() {
  const bar = document.getElementById('tickerInner');
  if (!bar) return;

  bar.innerHTML = TICKER_SYMBOLS.map(({ sym, name }) => `
    <div class="ticker-item" id="${tickId(sym)}" data-symbol="${sym}">
      <span class="ticker-name">${name}</span>
      <span class="ticker-price">--</span>
      <span class="ticker-change">--</span>
    </div>
  `).join('');

  bar.querySelectorAll('.ticker-item').forEach(item => {
    item.addEventListener('click', () => {
      search(item.dataset.symbol);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  });

  await Promise.all(TICKER_SYMBOLS.map(({ sym }) => fetchTickerPrice(sym)));
}

async function fetchTickerPrice(sym) {
  const el = document.getElementById(tickId(sym));
  if (!el) return;
  try {
    const data = await yahooFetch(`chart/${sym}?range=1d&interval=1d`, 10000);
    const meta = data?.chart?.result?.[0]?.meta;
    if (!meta) return;
    const price  = meta.regularMarketPrice ?? 0;
    const prev   = meta.chartPreviousClose ?? meta.previousClose ?? price;
    const change = price - prev;
    const pct    = prev ? (change / prev) * 100 : 0;
    const up     = change >= 0;
    el.querySelector('.ticker-price').textContent = price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const chEl = el.querySelector('.ticker-change');
    chEl.textContent = `${up ? '+' : ''}${pct.toFixed(2)}%`;
    chEl.className   = 'ticker-change ' + (up ? 'up' : 'down');
  } catch (_) {
    el.querySelector('.ticker-price').textContent = '--';
  }
}

// ── Watchlist ─────────────────────────────────────────
let watchlist = JSON.parse(localStorage.getItem('watchlist') || '[]');

addWatchBtn.addEventListener('click', () => {
  if (!currentSymbol) return;
  if (watchlist.includes(currentSymbol)) { showToast(`${currentSymbol} 已在自選清單中`); return; }
  watchlist.push(currentSymbol);
  saveWatchlist();
  renderWatchlist();
  showToast(`已加入 ${currentSymbol}`);
});

function saveWatchlist() { localStorage.setItem('watchlist', JSON.stringify(watchlist)); }

function removeFromWatchlist(sym) {
  watchlist = watchlist.filter(s => s !== sym);
  saveWatchlist();
  renderWatchlist();
  showToast(`已移除 ${sym}`);
}

async function renderWatchlist() {
  if (!watchlist.length) {
    watchGrid.innerHTML = '<p class="empty-hint">尚無自選股票，搜尋後點擊「加入自選」新增。</p>';
    return;
  }
  watchGrid.innerHTML = watchlist.map(s => `
    <div class="watch-card" data-symbol="${s}">
      <button class="watch-remove" data-sym="${s}" title="移除">✕</button>
      <div class="watch-card-symbol">${s}</div>
      <div class="watch-card-price" id="wp-${s}">載入中…</div>
      <div class="watch-card-change" id="wc-${s}"></div>
    </div>
  `).join('');

  watchGrid.querySelectorAll('.watch-card').forEach(card => {
    card.addEventListener('click', e => {
      if (e.target.classList.contains('watch-remove')) return;
      search(card.dataset.symbol);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  });
  watchGrid.querySelectorAll('.watch-remove').forEach(btn => {
    btn.addEventListener('click', () => removeFromWatchlist(btn.dataset.sym));
  });

  await Promise.all(watchlist.map(s => fetchWatchPrice(s)));
}

async function fetchWatchPrice(sym) {
  try {
    const data = await yahooFetch(`chart/${sym}?range=1d&interval=1d`);
    const meta = data?.chart?.result?.[0]?.meta;
    if (!meta) return;
    const price  = meta.regularMarketPrice ?? 0;
    const prev   = meta.chartPreviousClose ?? meta.previousClose ?? price;
    const change = price - prev;
    const pct    = prev ? (change / prev) * 100 : 0;
    const up     = change >= 0;
    const pe = document.getElementById(`wp-${sym}`);
    const ce = document.getElementById(`wc-${sym}`);
    if (pe) pe.textContent = fmt(price, meta.currency);
    if (ce) {
      ce.textContent = `${up ? '+' : ''}${change.toFixed(2)} (${up ? '+' : ''}${pct.toFixed(2)}%)`;
      ce.className   = 'watch-card-change ' + (up ? 'up' : 'down');
    }
  } catch (_) {}
}

// ── Utils ──────────────────────────────────────────────
function fmt(val, currency) {
  if (val == null || isNaN(val)) return '--';
  const sym = currency === 'TWD' ? 'NT$'
            : currency === 'USD' ? '$'
            : (currency ? currency + ' ' : '');
  return sym + Number(val).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtVol(v) {
  if (v == null) return '--';
  if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K';
  return v.toString();
}

function hexAlpha(hex, a) {
  const r = parseInt(hex.slice(1,3), 16);
  const g = parseInt(hex.slice(3,5), 16);
  const b = parseInt(hex.slice(5,7), 16);
  return `rgba(${r},${g},${b},${a})`;
}

let toastTimer;
function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2800);
}

// ── Init ───────────────────────────────────────────────
loadMarketTicker();
renderWatchlist();
if (!watchlist.length) search('AAPL');
