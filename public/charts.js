// Presentation only: draws Folio's charts from numbers the server already worked out.
// No business rules here. Plain SVG and HTML, no chart library.
//
//   FolioCharts.valueChart(container, points, { range, tooltip })
//     Line chart of market value vs. amount invested, with a crosshair tooltip.
//   FolioCharts.gainLossBars(list, rows)
//     Horizontal bars growing left (loss) or right (gain) from one zero line.
//   FolioCharts.allocationSplit(el, allocation, colorFor)
//     One bar split into each holding's share of total value.
//
// Labels come from the server (tickers), so they go into the page with textContent only.

(function () {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
  const wholeMoney = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  const compactMoney = new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1,
  });

  function svg(name, attrs = {}, parent = null) {
    const node = document.createElementNS(SVG_NS, name);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    if (parent) parent.appendChild(node);
    return node;
  }

  function html(name, { className, text } = {}, parent = null) {
    const node = document.createElement(name);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    if (parent) parent.appendChild(node);
    return node;
  }

  // "+$1,234.56" / "−$50.00" (a real minus sign, so the sign reads clearly).
  const signedMoney = (n) => (n > 0 ? '+' : n < 0 ? '−' : '') + money.format(Math.abs(n));
  const signedPct = (n) => (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n).toFixed(1) + '%';

  // ---- Axes ----

  // A round step (1, 2, 2.5, 5 × 10^n) that splits span into about `count` parts.
  function niceStep(span, count) {
    const raw = span / count;
    const mag = 10 ** Math.floor(Math.log10(raw));
    const norm = raw / mag;
    return (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  }

  function valueTicks(min, max) {
    if (max - min < 1) { min -= 50; max += 50; } // flat line: give it some room
    const step = niceStep(max - min, 4);
    let lo = Math.floor(min / step) * step;
    const hi = Math.ceil(max / step) * step;
    if (lo < 0 && min >= 0) lo = 0;
    const ticks = [];
    for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v * 100) / 100);
    // One style per axis: compact once the axis reaches 10,000.
    const format = hi >= 10000 ? (v) => compactMoney.format(v) : (v) => wholeMoney.format(v);
    return { lo, hi, ticks, format };
  }

  const toTime = (date) => Date.parse(`${date}T00:00:00Z`);
  const dateFormat = (opts) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', ...opts });
  const longDate = dateFormat({ weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  const AXIS_DATE = {
    '1mo': dateFormat({ month: 'short', day: 'numeric' }),
    '3mo': dateFormat({ month: 'short', day: 'numeric' }),
    '6mo': dateFormat({ month: 'short', day: 'numeric' }),
    '1y': dateFormat({ month: 'short', year: '2-digit' }),
    '5y': dateFormat({ year: 'numeric' }),
  };

  // ---- Value over time ----

  // benchmarkName: when the points have a benchmark value (the same money in an
  // index fund), it's drawn as a dashed line and named in the tooltip and labels.
  function valueChart(container, points, { range = '1y', tooltip = null, emptyText = '', benchmarkName = null } = {}) {
    container.replaceChildren();
    if (tooltip) {
      tooltip.hidden = true;
      container.appendChild(tooltip);
    }
    if (points.length < 2) {
      html('div', { className: 'chart-empty', text: emptyText }, container);
      return;
    }

    const width = Math.max(280, container.clientWidth);
    const narrow = width < 520;
    const plotHeight = narrow ? 190 : 240;
    const top = 12;
    const axisBand = 28;
    const height = top + plotHeight + axisBand;

    const hasBenchmark = benchmarkName !== null && points.every((p) => typeof p.benchmark === 'number');
    const all = points.flatMap((p) => (hasBenchmark ? [p.value, p.invested, p.benchmark] : [p.value, p.invested]));
    const y = valueTicks(Math.min(...all), Math.max(...all));
    const longestTick = Math.max(...y.ticks.map((t) => y.format(t).length));
    const left = 10 + longestTick * 7;
    const right = narrow ? 10 : 84; // room for the end labels
    const plotWidth = width - left - right;

    const t0 = toTime(points[0].date);
    const t1 = toTime(points.at(-1).date);
    const xs = points.map((p) => left + ((toTime(p.date) - t0) / (t1 - t0)) * plotWidth);
    const yOf = (v) => top + plotHeight - ((v - y.lo) / (y.hi - y.lo)) * plotHeight;
    const bottom = top + plotHeight;

    const last = points.at(-1);
    const root = svg('svg', {
      viewBox: `0 0 ${width} ${height}`,
      height,
      tabindex: '0',
      role: 'img',
      'aria-label': `Line chart of market value and amount invested${hasBenchmark ? `, and the same money in the ${benchmarkName}` : ''}, `
        + `from ${longDate.format(new Date(t0))} to ${longDate.format(new Date(t1))}. Ends at ${money.format(last.value)} market value, `
        + `${money.format(last.invested)} invested${hasBenchmark ? ` and ${money.format(last.benchmark)} in the ${benchmarkName}` : ''}. `
        + 'Use the left and right arrow keys to read each day.',
    }, container);

    // Gridlines and value labels (recessive), then the baseline.
    for (const tick of y.ticks) {
      const ty = yOf(tick);
      if (tick !== y.lo) svg('line', { x1: left, x2: left + plotWidth, y1: ty, y2: ty, stroke: 'var(--chart-grid)', 'stroke-width': 1 }, root);
      const label = svg('text', { x: left - 8, y: ty + 4, 'text-anchor': 'end', 'font-size': 11, fill: 'var(--chart-muted)' }, root);
      label.textContent = y.format(tick);
    }
    svg('line', { x1: left, x2: left + plotWidth, y1: bottom, y2: bottom, stroke: 'var(--chart-axis)', 'stroke-width': 1 }, root);

    // Date labels, evenly spaced in time.
    const fmt = AXIS_DATE[range] ?? AXIS_DATE['1y'];
    const tickCount = narrow ? 3 : 5;
    let lastLabel = null;
    for (let i = 0; i < tickCount; i += 1) {
      const t = t0 + ((t1 - t0) * i) / (tickCount - 1);
      const text = fmt.format(new Date(t));
      if (text === lastLabel) continue; // e.g. two ticks in the same year
      lastLabel = text;
      const anchor = i === 0 ? 'start' : i === tickCount - 1 ? 'end' : 'middle';
      const label = svg('text', {
        x: left + (plotWidth * i) / (tickCount - 1), y: bottom + 18, 'text-anchor': anchor, 'font-size': 11, fill: 'var(--chart-muted)',
      }, root);
      label.textContent = text;
    }

    // The value line with a light wash under it; invested as steps (money arrives on a date).
    const valuePath = points.map((p, i) => `${i ? 'L' : 'M'}${xs[i].toFixed(1)},${yOf(p.value).toFixed(1)}`).join('');
    svg('path', {
      d: `${valuePath}L${xs.at(-1).toFixed(1)},${bottom}L${xs[0].toFixed(1)},${bottom}Z`,
      fill: 'var(--series-value)', 'fill-opacity': 0.1, stroke: 'none',
    }, root);
    let investedPath = `M${xs[0].toFixed(1)},${yOf(points[0].invested).toFixed(1)}`;
    for (let i = 1; i < points.length; i += 1) {
      investedPath += `H${xs[i].toFixed(1)}V${yOf(points[i].invested).toFixed(1)}`;
    }
    const line = { fill: 'none', 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' };
    svg('path', { d: investedPath, stroke: 'var(--series-invested)', ...line }, root);
    // The comparison is dashed, so it's told apart by more than its color.
    if (hasBenchmark) {
      const benchPath = points.map((p, i) => `${i ? 'L' : 'M'}${xs[i].toFixed(1)},${yOf(p.benchmark).toFixed(1)}`).join('');
      svg('path', { d: benchPath, stroke: 'var(--series-benchmark)', 'stroke-dasharray': '5 4', ...line }, root);
    }
    svg('path', { d: valuePath, stroke: 'var(--series-value)', ...line }, root);

    // End markers and labels. If the two ends are too close, label only the value
    // (the legend and tooltip still name both) rather than stacking labels.
    const endX = xs.at(-1);
    const endValueY = yOf(last.value);
    const endInvestedY = yOf(last.invested);
    const endBenchY = hasBenchmark ? yOf(last.benchmark) : null;
    const dot = (cx, cy, color) => svg('circle', { cx, cy, r: 4, fill: color, stroke: 'var(--card)', 'stroke-width': 2 }, root);
    dot(endX, endInvestedY, 'var(--series-invested)');
    if (hasBenchmark) dot(endX, endBenchY, 'var(--series-benchmark)');
    dot(endX, endValueY, 'var(--series-value)');
    if (!narrow) {
      const endLabel = (cy, text, color) => {
        const t = svg('text', { x: endX + 10, y: cy + 4, 'font-size': 12, fill: color, 'font-weight': 600 }, root);
        t.textContent = text;
      };
      // Labels go on in order of importance, each only where it won't overlap one
      // already placed (the legend and tooltip still name every line).
      const placed = [];
      const tryLabel = (cy, text, color) => {
        if (placed.some((y) => Math.abs(y - cy) < 16)) return;
        placed.push(cy);
        endLabel(cy, text, color);
      };
      tryLabel(endValueY, compactOrFull(last.value), 'var(--ink)');
      if (hasBenchmark) tryLabel(endBenchY, compactOrFull(last.benchmark), 'var(--ink-soft)');
      tryLabel(endInvestedY, compactOrFull(last.invested), 'var(--ink-soft)');
    }

    // ---- Hover / keyboard layer: a crosshair that snaps to the nearest day ----
    const cross = svg('line', { y1: top, y2: bottom, stroke: 'var(--ink-soft)', 'stroke-opacity': 0.35, 'stroke-width': 1, visibility: 'hidden' }, root);
    const hoverInvested = dot(0, 0, 'var(--series-invested)');
    const hoverBench = hasBenchmark ? dot(0, 0, 'var(--series-benchmark)') : null;
    const hoverValue = dot(0, 0, 'var(--series-value)');
    const hoverMarks = [cross, hoverInvested, hoverValue, ...(hoverBench ? [hoverBench] : [])];
    for (const d of hoverMarks) d.setAttribute('visibility', 'hidden');
    const hit = svg('rect', { x: left, y: top, width: plotWidth, height: plotHeight, fill: 'transparent' }, root);

    let index = points.length - 1;
    function show(i) {
      index = Math.max(0, Math.min(points.length - 1, i));
      const p = points[index];
      const x = xs[index];
      cross.setAttribute('x1', x);
      cross.setAttribute('x2', x);
      hoverValue.setAttribute('cx', x);
      hoverValue.setAttribute('cy', yOf(p.value));
      hoverInvested.setAttribute('cx', x);
      hoverInvested.setAttribute('cy', yOf(p.invested));
      if (hoverBench) {
        hoverBench.setAttribute('cx', x);
        hoverBench.setAttribute('cy', yOf(p.benchmark));
      }
      for (const node of hoverMarks) node.setAttribute('visibility', 'visible');
      if (tooltip) fillTooltip(tooltip, p, x, container, width, hasBenchmark ? benchmarkName : null);
    }
    function hide() {
      for (const node of hoverMarks) node.setAttribute('visibility', 'hidden');
      if (tooltip) tooltip.hidden = true;
    }
    function nearest(clientX) {
      const box = root.getBoundingClientRect();
      const x = ((clientX - box.left) / box.width) * width;
      let best = 0;
      for (let i = 1; i < xs.length; i += 1) if (Math.abs(xs[i] - x) < Math.abs(xs[best] - x)) best = i;
      return best;
    }
    hit.addEventListener('pointermove', (e) => show(nearest(e.clientX)));
    hit.addEventListener('pointerdown', (e) => show(nearest(e.clientX)));
    root.addEventListener('pointerleave', hide);
    root.addEventListener('focus', () => show(index));
    root.addEventListener('blur', hide);
    root.addEventListener('keydown', (e) => {
      const step = { ArrowLeft: -1, ArrowRight: 1 }[e.key];
      if (step) show(index + step);
      else if (e.key === 'Home') show(0);
      else if (e.key === 'End') show(points.length - 1);
      else return;
      e.preventDefault();
    });
  }

  const compactOrFull = (v) => (Math.abs(v) >= 100000 ? compactMoney.format(v) : wholeMoney.format(v));

  // Values lead, names follow; each series keyed by a short line in its color.
  function fillTooltip(tip, p, x, container, width, benchmarkName = null) {
    tip.replaceChildren();
    html('div', { className: 'tip-date', text: longDate.format(new Date(toTime(p.date))) }, tip);
    const row = (color, value, name) => {
      const r = html('div', { className: 'tip-row' }, tip);
      const key = html('span', { className: 'key-line' }, r);
      if (color) key.style.background = color;
      else key.style.visibility = 'hidden';
      html('strong', { text: value }, r);
      html('span', { text: name }, r);
      return r;
    };
    row('var(--series-value)', money.format(p.value), 'Market value');
    row('var(--series-invested)', money.format(p.invested), 'Invested');
    const gain = p.value - p.invested;
    const pct = p.invested > 0 ? ` (${signedPct((gain / p.invested) * 100)})` : '';
    row(null, signedMoney(gain) + pct, 'Gain/loss');
    if (benchmarkName) {
      const benchRow = row('var(--series-benchmark)', money.format(p.benchmark), `Same money in the ${benchmarkName}`);
      benchRow.querySelector('.key-line').classList.add('dashed');
    }

    tip.hidden = false;
    const scale = container.clientWidth / width;
    const tipWidth = tip.offsetWidth;
    let leftPx = x * scale + 14;
    if (leftPx + tipWidth > container.clientWidth) leftPx = x * scale - 14 - tipWidth;
    tip.style.left = `${Math.max(0, leftPx)}px`;
    tip.style.top = '4px';
  }

  // ---- Gain/loss by holding ----

  function gainLossBars(list, rows) {
    list.replaceChildren();
    const priced = rows.filter((r) => r.gainLoss !== null).sort((a, b) => b.gainLoss - a.gainLoss);
    const lo = Math.min(0, ...priced.map((r) => r.gainLoss));
    const hi = Math.max(0, ...priced.map((r) => r.gainLoss));
    const span = hi - lo || 1;
    const zero = (-lo / span) * 100;

    for (const r of priced) {
      const li = html('li', {}, list);
      const kind = r.gainLoss >= 0 ? 'gain' : 'loss';
      const pct = r.gainLossPercent === null ? '' : `, ${signedPct(r.gainLossPercent)}`;
      li.title = `${r.ticker}: ${kind === 'gain' ? 'up' : 'down'} ${money.format(Math.abs(r.gainLoss))}${pct} since purchase`;
      html('span', { text: r.ticker }, li);

      const track = html('span', { className: 'gl-track' }, li);
      track.setAttribute('aria-hidden', 'true');
      const zeroLine = html('span', { className: 'gl-zero' }, track);
      zeroLine.style.left = `${zero}%`;
      const bar = html('span', { className: `gl-bar ${kind}` }, track);
      const w = (Math.abs(r.gainLoss) / span) * 100;
      bar.style.width = `${w}%`;
      bar.style.left = kind === 'gain' ? `${zero}%` : `${zero - w}%`;

      const value = html('span', { className: `num ${r.gainLoss > 0 ? 'gain' : r.gainLoss < 0 ? 'loss' : ''}`, text: signedMoney(r.gainLoss) }, li);
      if (r.gainLossPercent !== null) html('span', { className: 'pct', text: signedPct(r.gainLossPercent) }, value);
    }
    return priced.length;
  }

  // ---- Allocation split bar ----

  // colorFor(label) -> { color, darkText }. Each part's share is printed inside it
  // only when it fits; the list below always has every number.
  function allocationSplit(el, allocation, colorFor) {
    el.replaceChildren();
    const names = [];
    for (const part of allocation) {
      const name = part.count ? `Other (${part.count} tickers)` : part.label;
      const share = `${part.percent.toFixed(part.percent < 10 ? 1 : 0)}%`;
      names.push(`${name} ${share}`);
      const block = html('span', {}, el);
      html('span', { text: share }, block);
      const { color, darkText } = colorFor(part.label);
      block.style.background = color;
      block.style.flex = `${part.value} 0 0`;
      if (darkText) block.classList.add('dark-text');
      block.title = `${name}: ${money.format(part.value)}, ${part.percent.toFixed(1)}% of total value`;
    }
    el.setAttribute('aria-label', `Share of total value: ${names.join(', ')}`);
    fitSplitLabels(el);
  }

  // Hide a label that doesn't fit its block with 8px padding each side (never clip it).
  // Called again when the page resizes.
  function fitSplitLabels(el) {
    for (const block of el.children) {
      const label = block.firstElementChild;
      label.style.visibility = '';
      if (label.offsetWidth + 16 > block.clientWidth) label.style.visibility = 'hidden';
    }
  }

  window.FolioCharts = { valueChart, gainLossBars, allocationSplit, fitSplitLabels };
})();
