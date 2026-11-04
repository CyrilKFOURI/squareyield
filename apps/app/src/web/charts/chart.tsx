// ECharts wrapper for DOM screens: only the chart types and components the dashboard uses are bundled,
// colours and fonts come from the theme tokens so charts follow light / dark.
import { BarChart, BoxplotChart, CustomChart, LineChart, ScatterChart } from 'echarts/charts';
import {
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  MarkAreaComponent,
  MarkLineComponent,
  MarkPointComponent,
  TooltipComponent,
} from 'echarts/components';
import * as echarts from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import { type CSSProperties, useEffect, useRef } from 'react';

import { useDark } from '../hooks/use-dark';

echarts.use([
  LineChart, BarChart, ScatterChart, BoxplotChart, CustomChart, GridComponent, TooltipComponent, LegendComponent,
  MarkLineComponent, MarkAreaComponent, MarkPointComponent, DataZoomComponent, CanvasRenderer,
]);

export type ChartOption = echarts.EChartsCoreOption;

/** Categorical colours: graphite first, then muted hues; enough for 6 compared places. */
export const SERIES_COLORS = ['#2c4a6b', '#b0602f', '#3d7a5a', '#7a4f8c', '#8a7a2a', '#4f8a9a'];

const frNumber = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 });
const frDecimal = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 2 });
/** French number formatting for axes and tooltips (1 234 not 1,234; decimals only under 100). */
export const frFormat = (value: unknown): string =>
  typeof value === 'number' ? (Math.abs(value) >= 100 ? frNumber : frDecimal).format(value) : String(value ?? '—');

export const css = (name: string): string =>
  typeof document === 'undefined' ? '' : getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** Axis, grid and tooltip styling shared by every chart. */
export const baseOption = (): ChartOption => ({
  textStyle: { fontFamily: 'Inter, ui-sans-serif, system-ui', color: css('--ink-2'), fontSize: 11 },
  color: SERIES_COLORS,
  grid: { left: 52, right: 16, top: 24, bottom: 28, containLabel: false },
  tooltip: {
    trigger: 'axis',
    backgroundColor: css('--surface'),
    borderColor: css('--line-strong'),
    borderWidth: 1,
    textStyle: { color: css('--ink-1'), fontSize: 12 },
    extraCssText: 'border-radius:3px;box-shadow:none;',
    valueFormatter: frFormat,
  },
  legend: { top: 0, right: 8, icon: 'rect', itemWidth: 10, itemHeight: 2, textStyle: { color: css('--ink-2') } },
});

export const axisStyle = () => ({
  axisLine: { lineStyle: { color: css('--line-strong') } },
  axisTick: { show: false },
  axisLabel: { color: css('--ink-3'), fontSize: 11, formatter: (v: unknown) => (typeof v === 'number' ? frFormat(v) : String(v)) },
  splitLine: { lineStyle: { color: css('--line') } },
});

type ChartProps = {
  option: ChartOption;
  height?: number | string;
  style?: CSSProperties;
  onClick?: (params: { name?: string; seriesName?: string; data?: unknown; dataIndex?: number }) => void;
  ariaLabel: string;
};

export const Chart = ({ option, height = 220, style, onClick, ariaLabel }: ChartProps) => {
  const ref = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);
  const clickRef = useRef(onClick);

  useEffect(() => {
    clickRef.current = onClick;
  }, [onClick]);

  useEffect(() => {
    if (!ref.current) {
      return;
    }
    const instance = echarts.init(ref.current, undefined, { renderer: 'canvas' });
    chart.current = instance;
    instance.on('click', (params) => clickRef.current?.(params as never));
    const observer = new ResizeObserver(() => instance.resize());
    observer.observe(ref.current);
    return () => {
      observer.disconnect();
      instance.dispose();
      chart.current = null;
    };
  }, []);

  // colours come from the theme tokens: redraw when the theme changes
  const dark = useDark();
  useEffect(() => {
    chart.current?.setOption({ ...baseOption(), ...option }, { notMerge: true });
  }, [option, dark]);

  return <div ref={ref} role="img" aria-label={ariaLabel} style={{ width: '100%', height, ...style }} />;
};
