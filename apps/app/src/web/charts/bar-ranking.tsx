// Every place of a level as one bar (départements of France, communes of a département), with the sort and
// top-N controls of docs/features/017-guided-levels/spec.md. Click a bar to open that place.
import { useState } from 'react';

import { type BarSort, rankBars } from '../../data/levels';
import { Segmented, Select } from '../components/controls';
import { isPhone } from '../hooks/phone';
import { axisStyle, Chart, css, frFormat } from './chart';

const TOUCH = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;

export type BarItem = { code: string; label: string; value: number | null; detail?: string };

const SORTS: { value: BarSort; label: string }[] = [
  { value: 'code', label: 'N°' },
  { value: 'desc', label: 'Plus hauts' },
  { value: 'asc', label: 'Plus bas' },
];

type BarRankingProps = {
  items: BarItem[];
  /** Name of the measure, for the axis tooltip and the accessible label. */
  metricLabel: string;
  format: (value: number) => string;
  /** Opens the place of a clicked bar. */
  onPick?: (code: string) => void;
  /** Reference line (France, the département…). */
  reference?: { label: string; value: number | null };
  /** Bars at or above zero in one tone, below in another (changes, cash-flow). */
  signed?: boolean;
  height?: number;
};

/** Sort / top controls rendered by the caller in a panel head; state lives here. */
export const useBarControls = (defaultSort: BarSort = 'code', defaultTop: number | null = null, tops = [10, 20, 50]) => {
  const [sort, setSort] = useState<BarSort>(defaultSort);
  const [top, setTop] = useState<string>(defaultTop == null ? 'all' : String(defaultTop));
  const controls = (
    <div className="cy-chart-tools">
      <Segmented label="Tri" options={SORTS} value={sort} onChange={setSort} />
      <Select
        label="Nombre affiché"
        value={top}
        onChange={setTop}
        options={[{ value: 'all', label: 'Tous' }, ...tops.map((t) => ({ value: String(t), label: `Top ${t}` }))]}
      />
    </div>
  );
  return { sort, top: top === 'all' ? null : Number(top), controls };
};

/** Rows visible at once in the phone list; the rest scrolls inside it. */
const PHONE_ROWS = 10;

/** Phone (023): a plain list of bars, about ten rows high, scrolled with one finger; no chart zoom. */
const PhoneBars = ({ shown, format, onPick, reference, signed }: { shown: BarItem[] } & Pick<BarRankingProps, 'format' | 'onPick' | 'reference' | 'signed'>) => {
  const max = Math.max(...shown.map((i) => Math.abs(i.value ?? 0)), Math.abs(reference?.value ?? 0)) || 1;
  const width = (v: number | null) => `${Math.round((Math.abs(v ?? 0) / max) * 100)}%`;
  const more = shown.length > PHONE_ROWS;
  return (
    <div className="cy-rank">
      {reference?.value != null && (
        <div className="cy-rank-row ref">
          <span className="cy-rank-n" />
          <span className="cy-rank-name">{reference.label}</span>
          <span className="cy-rank-bar"><i style={{ width: width(reference.value) }} /></span>
          <span className="cy-rank-v">{format(reference.value)}</span>
        </div>
      )}
      <ol className={more ? 'cy-rank-list scroll' : 'cy-rank-list'} style={{ ['--rows' as string]: Math.min(PHONE_ROWS, shown.length) }}>
        {shown.map((item, n) => (
          <li key={item.code}>
            <button type="button" className="cy-rank-row" onClick={() => onPick?.(item.code)} disabled={!onPick}>
              <span className="cy-rank-n">{n + 1}</span>
              <span className="cy-rank-name">{item.label}</span>
              <span className="cy-rank-bar">
                <i className={signed && (item.value ?? 0) < 0 ? 'neg' : undefined} style={{ width: width(item.value) }} />
              </span>
              <span className="cy-rank-v">{item.value == null ? '—' : format(item.value)}</span>
            </button>
          </li>
        ))}
      </ol>
      {more && <div className="cy-rank-foot">{shown.length} lieux · faites défiler la liste ↓</div>}
    </div>
  );
};

export const BarRanking = ({
  items,
  metricLabel,
  format,
  onPick,
  reference,
  signed,
  height = 320,
  sort,
  top,
}: BarRankingProps & { sort: BarSort; top: number | null }) => {
  const shown = rankBars(items, (i) => i.value, (i) => i.code, sort, top);
  if (isPhone()) {
    return <PhoneBars shown={shown} format={format} onPick={onPick} reference={reference} signed={signed} />;
  }
  const many = shown.length > 40;
  // names stay readable: cut long ones instead of falling back to a code; 40+ bars only fit codes
  const tick = (i: BarItem) => (many ? i.code : i.label.length > 16 ? `${i.label.slice(0, 15)}…` : i.label);
  // value on each bar: above it when there is room, written up the bar when they are narrow
  const label = shown.length <= 12
    ? { show: true, position: 'top', fontSize: 10, color: css('--ink-2'), formatter: (p: { value: number }) => format(p.value) }
    : shown.length <= 40
      ? { show: true, position: 'insideBottom', rotate: 90, align: 'left', verticalAlign: 'middle', distance: 6, fontSize: 10,
          color: css('--on-accent'), formatter: (p: { value: number }) => format(p.value) }
      : undefined;
  const pos = css('--accent');
  const neg = css('--neg');
  return (
    <Chart
      ariaLabel={`${metricLabel} : ${shown.length} lieux`}
      height={height}
      onClick={(p) => p.dataIndex != null && onPick?.(shown[p.dataIndex].code)}
      option={{
        grid: { left: 56, right: 16, top: 20, bottom: many ? 56 : 70 },
        tooltip: {
          trigger: 'axis',
          axisPointer: { type: 'shadow' },
          formatter: (params: { dataIndex: number }[]) => {
            const item = shown[params[0]?.dataIndex ?? 0];
            return item ? `<b>${item.label}</b><br/>${metricLabel} : ${format(item.value as number)}${item.detail ? `<br/>${item.detail}` : ''}` : '';
          },
        },
        // on a touch screen a finger drag over the chart scrolls the page (023): zoom with the slider only
        dataZoom: many ? [{ type: TOUCH ? 'slider' : 'inside', start: 0, end: Math.min(100, (60 / shown.length) * 100), ...(TOUCH ? { height: 22, bottom: 4 } : {}) },
          ...(TOUCH ? [] : [{ type: 'slider', height: 14, bottom: 6 }])] : [],
        xAxis: {
          type: 'category',
          data: shown.map(tick),
          ...axisStyle(),
          axisLabel: { ...axisStyle().axisLabel, interval: 0, rotate: many ? 0 : 40, fontSize: 10 },
        },
        // bars start at zero (a cut axis exaggerates gaps); the reference line stays inside the frame
        yAxis: { type: 'value', ...axisStyle(),
          ...(reference?.value != null ? {
            min: (v: { min: number }) => Math.min(0, v.min, reference.value as number),
            max: (v: { max: number }) => Math.max(0, v.max, reference.value as number),
          } : {}), axisLabel: { ...axisStyle().axisLabel, formatter: (v: number) => format(v) } },
        series: [
          {
            type: 'bar',
            barMaxWidth: 22,
            cursor: onPick ? 'pointer' : 'default',
            data: shown.map((i) => ({ value: i.value, itemStyle: { color: signed && (i.value as number) < 0 ? neg : pos } })),
            label,
            markLine: reference?.value != null
              ? { symbol: 'none', silent: true, lineStyle: { color: css('--ink-2'), type: 'dashed' },
                  label: { formatter: `${reference.label} ${format(reference.value)}`, position: 'insideEndTop', color: css('--ink-2'), fontSize: 10 },
                  data: [{ yAxis: reference.value }] }
              : undefined,
          },
        ],
      }}
    />
  );
};

/** Diverging colour range of yearly changes: ±10 % covers almost every département. */
export const CHANGE_RANGE = 0.1;

export const changeFormat = (v: number) => `${v >= 0 ? '+' : ''}${frFormat(Math.round(v * 1000) / 10)} %`;
