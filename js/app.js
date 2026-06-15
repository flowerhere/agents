/* ===================================================
   Stock Chart App
   Uses Yahoo Finance proxy via allorigins.win to
   avoid CORS issues on GitHub Pages (static hosting).
   Data is delayed / non-realtime — for reference only.
   =================================================== */

const PROXY = 'https://api.allorigins.win/get?url=';

/* ── DOM refs ── */
const symbolInput   = document.getElementById('symbolInput');
const searchBtn     = document.getElementById('searchBtn');
const stockInfo     = document.getElementById('stockInfo');
const chartSection  = document.getElementById('chartSection');
const chartLoading  = document.getElementById('chartLoading');
const addWatchBtn   = document.getElementById('addToWatchlist');
const watchGrid     = document.getElementById('watchlistGrid');
const toastEl       = document.getElementById('toast');

let chartInstance   = null;
let currentSymbol   = '';
let currentPeriod   = '1mo';
let currentType     = 'line';

/* ── Quick picks ── */
document.querySelectorAll('.quick-btn').forEach(btn => {
  btn.addEventListener('click', () => search(btn.dataset.symbol));
});

/* ── Period buttons ── */
document.querySelectorAll('.period-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.period-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentPeriod = btn.dataset.period;
    if (currentSymbol) loadChart(currentSymbol, currentPeriod);
  });
});

/* ── Chart type buttons ── */
document.querySelectorAll('.type-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.type-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentType = btn.dataset.type;
    if (currentSymbol) loadChart(currentSymbol, currentPeriod);
  });
});

/* ── Search ── */
searchBtn.addEventListener('click', () => search(symbolInput.value.trim()));
symbolInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') search(symbolInput.value.trim());
});

async function search(symbol) {
  if (!symbol) return;
  symbol = symbol.toUpperCase();
  symbolInput.value = symbol;
  currentSymbol = symbol;

  stockInfo.style.display = 'none';
  chartSection.style.display = 'none';
  addWatchBtn.style.display = 'none';

  await Promise.all([loadQuote(symbol), loadChart(symbol, currentPeriod)]);

  stockInfo.style.display = '';
  chartSection.style.display = '';
  addWatchBtn.style.display = '';
}

/* ── Yahoo Finance helpers ── */
function yahooUrl(endpoint) {
  return PROXY + encodeURIComponent('https://query1.finance.yahoo.com/v8/finance/' + endpoint);
}

function periodToRange(period) {
  const map = {
    '1d':  { range: '1d',  interval: '5m'  },
    '5d':  { range: '5d',  interval: '30m' },
    '1mo': { range: '1mo', interval: '1d'  },
    '3mo': { range: '3mo', interval: '1d'  },
    '6mo': { range: '6mo', interval: '1wk' },
    '1y':  { range: '1y',  interval: '1wk' },
    '5y':  { range: '5y',  interval: '1mo' },
  };
  return map[period] || map['1mo'];
}

/* ── Load quote summary ── */
async function loadQuote(symbol) {
  try {
    const url = yahooUrl(`chart/${symbol}?range=1d&interval=1d`);
    const res  = await fetch(url);
    const json = await res.json();
    const data = JSON.parse(json.contents);
    const meta = data?.chart?.result?.[0]?.meta;
    if (!meta) throw new Error('no meta');

    const price  = meta.regularMarketPrice ?? '--';
    const prev   = meta.chartPreviousClose ?? meta.previousClose ?? price;
    const change = price - prev;
    const pct    = (change / prev) * 100;
    const up     = change >= 0;

    document.getElementById('stockName').textContent    = meta.longName || meta.shortName || symbol;
    document.getElementById('stockSymbol').textContent  = symbol;
    document.getElementById('stockPrice').textContent   = fmt(price, meta.currency);
    const chEl = document.getElementById('priceChange');
    chEl.textContent  = `${up ? '+' : ''}${fmt(change, meta.currency)} (${up ? '+' : ''}${pct.toFixed(2)}%)`;
    chEl.className    = 'price-change ' + (up ? 'up' : 'down');

    document.getElementById('infoOpen').textContent    = fmt(meta.regularMarketOpen, meta.currency);
    document.getElementById('infoHigh').textContent    = fmt(meta.regularMarketDayHigh, meta.currency);
    document.getElementById('infoLow').textContent     = fmt(meta.regularMarketDayLow, meta.currency);
    document.getElementById('infoVolume').textContent  = fmtVol(meta.regularMarketVolume);
    document.getElementById('info52High').textContent  = fmt(meta.fiftyTwoWeekHigh, meta.currency);
    document.getElementById('info52Low').textContent   = fmt(meta.fiftyTwoWeekLow, meta.currency);
  } catch (e) {
    console.warn('loadQuote error', e);
  }
}

/* ── Load chart data ── */
async function loadChart(symbol, period) {
  chartLoading.classList.add('show');
  try {
    const { range, interval } = periodToRange(period);
    const url = yahooUrl(`chart/${symbol}?range=${range}&interval=${interval}`);
    const res  = await fetch(url);
    const json = await res.json();
    const data = JSON.parse(json.contents);
    const result = data?.chart?.result?.[0];
    if (!result) throw new Error('no result');

    const timestamps = result.timestamp ?? [];
    const ohlcv       = result.indicators?.quote?.[0] ?? {};
    const closes      = ohlcv.close ?? [];
    const opens       = ohlcv.open  ?? [];
    const highs       = ohlcv.high  ?? [];
    const lows        = ohlcv.low   ?? [];

    const points = timestamps
      .map((t, i) => ({
        x: new Date(t * 1000),
        o: opens[i],
        h: highs[i],
        l: lows[i],
        c: closes[i],
      }))
      .filter(p => p.c != null);

    renderChart(points, period, symbol);
  } catch (e) {
    console.warn('loadChart error', e);
    showToast('無法載入圖表資料，請確認股票代號是否正確。');
  } finally {
    chartLoading.classList.remove('show');
  }
}

/* ── Render chart ── */
function renderChart(points, period, symbol) {
  const canvas = document.getElementById('stockChart');
  if (chartInstance) { chartInstance.destroy(); chartInstance = null; }

  const isLine = currentType === 'line';
  const first  = points[0]?.c ?? 0;
  const last   = points[points.length - 1]?.c ?? 0;
  const up     = last >= first;
  const color  = up ? '#3fb950' : '#f85149';

  const timeUnit = ['1d','5d'].includes(period) ? 'hour'
                 : ['1mo','3mo'].includes(period) ? 'day'
                 : ['6mo','1y'].includes(period) ? 'week'
                 : 'month';

  const datasets = isLine
    ? [{
        label: symbol,
        data: points.map(p => ({ x: p.x, y: p.c })),
        borderColor: color,
        backgroundColor: hexAlpha(color, .12),
        borderWidth: 2,
        pointRadius: 0,
        fill: true,
        tension: 0.3,
        type: 'line',
      }]
    : [{
        label: symbol,
        data: points.map(p => ({ x: p.x, o: p.o, h: p.h, l: p.l, c: p.c })),
        borderColor: ctx => {
          const raw = ctx.raw;
          if (!raw) return '#8b949e';
          return raw.c >= raw.o ? '#3fb950' : '#f85149';
        },
        backgroundColor: ctx => {
          const raw = ctx.raw;
          if (!raw) return '#8b949e';
          return raw.c >= raw.o ? hexAlpha('#3fb950', .7) : hexAlpha('#f85149', .7);
        },
        borderWidth: 1,
        type: 'candlestick',
      }];

  /* Fall back to line if candlestick plugin not available */
  const type = (isLine || !Chart.registry.controllers.candlestick) ? 'line' : 'candlestick';
  if (!isLine && type === 'line') {
    datasets[0] = {
      label: symbol,
      data: points.map(p => ({ x: p.x, y: p.c })),
      borderColor: color,
      backgroundColor: hexAlpha(color, .12),
      borderWidth: 2,
      pointRadius: 0,
      fill: true,
      tension: 0.3,
    };
  }

  chartInstance = new Chart(canvas, {
    type: 'line',
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#21262d',
          borderColor: '#30363d',
          borderWidth: 1,
          titleColor: '#8b949e',
          bodyColor: '#e6edf3',
          callbacks: {
            label: ctx => {
              const v = ctx.parsed.y;
              return v != null ? ` ${v.toFixed(2)}` : '';
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

/* ── Watchlist ── */
let watchlist = JSON.parse(localStorage.getItem('watchlist') || '[]');

addWatchBtn.addEventListener('click', () => {
  if (!currentSymbol) return;
  if (watchlist.includes(currentSymbol)) {
    showToast(`${currentSymbol} 已在自選清單中`);
    return;
  }
  watchlist.push(currentSymbol);
  saveWatchlist();
  renderWatchlist();
  showToast(`已加入 ${currentSymbol}`);
});

function saveWatchlist() {
  localStorage.setItem('watchlist', JSON.stringify(watchlist));
}

function removeFromWatchlist(symbol) {
  watchlist = watchlist.filter(s => s !== symbol);
  saveWatchlist();
  renderWatchlist();
  showToast(`已移除 ${symbol}`);
}

async function renderWatchlist() {
  if (watchlist.length === 0) {
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

  document.querySelectorAll('.watch-card').forEach(card => {
    card.addEventListener('click', e => {
      if (e.target.classList.contains('watch-remove')) return;
      search(card.dataset.symbol);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  });
  document.querySelectorAll('.watch-remove').forEach(btn => {
    btn.addEventListener('click', () => removeFromWatchlist(btn.dataset.sym));
  });

  /* fetch prices in parallel */
  await Promise.all(watchlist.map(s => fetchWatchPrice(s)));
}

async function fetchWatchPrice(symbol) {
  try {
    const url  = yahooUrl(`chart/${symbol}?range=1d&interval=1d`);
    const res  = await fetch(url);
    const json = await res.json();
    const meta = JSON.parse(json.contents)?.chart?.result?.[0]?.meta;
    if (!meta) return;
    const price  = meta.regularMarketPrice ?? 0;
    const prev   = meta.chartPreviousClose ?? meta.previousClose ?? price;
    const change = price - prev;
    const pct    = (change / prev) * 100;
    const up     = change >= 0;

    const pe = document.getElementById(`wp-${symbol}`);
    const ce = document.getElementById(`wc-${symbol}`);
    if (pe) pe.textContent = fmt(price, meta.currency);
    if (ce) {
      ce.textContent  = `${up ? '+' : ''}${change.toFixed(2)} (${up ? '+' : ''}${pct.toFixed(2)}%)`;
      ce.className    = 'watch-card-change ' + (up ? 'up' : 'down');
    }
  } catch (_) {}
}

/* ── Utils ── */
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
  const r = parseInt(hex.slice(1,3),16);
  const g = parseInt(hex.slice(3,5),16);
  const b = parseInt(hex.slice(5,7),16);
  return `rgba(${r},${g},${b},${a})`;
}

let toastTimer;
function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2800);
}

/* ── Init ── */
renderWatchlist();

/* Auto-load AAPL on first visit */
if (watchlist.length === 0) {
  search('AAPL');
}
