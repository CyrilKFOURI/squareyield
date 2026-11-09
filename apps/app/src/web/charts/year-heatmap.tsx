// Places × years, each cell the yearly change of the median €/m² (red falls, green rises). Answers "which
// département rose more than the others, and when". Click a row label or a cell to open the place.
import { axisStyle, Chart, css } from './chart';
import { CHANGE_RANGE, changeFormat } from './bar-ranking';

export type HeatRow = { code: string; label: string; changes: (number | null)[]; medians: (number | null)[] };

type YearHeatmapProps = {
  years: string[];
  rows: HeatRow[];
  onPick?: (code: string) => void;
  /** Pixel height of one row; the chart grows with the rows. */
  rowHeight?: number;
};

export const YearHeatmap = ({ years, rows, onPick, rowHeight = 16 }: YearHeatmapProps) => {
  // years after the first carry a change; the first year is the base
  const shownYears = years.slice(1);
  const data = rows.flatMap((row, y) =>
    shownYears.map((_, x) => {
      const change = row.changes[x + 1];
      // 4th value = the change clamped to the colour range, so a +25 % year is dark green, not unstyled
      return change == null ? [x, y, '-', '-'] : [x, y, change, Math.max(-CHANGE_RANGE, Math.min(CHANGE_RANGE, change))];
    }),
  );
  const height = Math.max(160, rows.length * rowHeight + 70);
  return (
    <Chart
      ariaLabel={`Variation annuelle du prix au m², ${rows.length} lieux, ${shownYears[0]} à ${shownYears[shownYears.length - 1]}`}
      height={height}
      onClick={(p) => {
        const value = p.data as [number, number] | undefined;
        if (value) {
          onPick?.(rows[value[1]].code);
        }
      }}
      option={{
        grid: { left: 150, right: 70, top: 8, bottom: 40 },
        tooltip: {
          trigger: 'item',
          formatter: (p: { data: [number, number, number | '-'] }) => {
            const [x, y, v] = p.data;
            const row = rows[y];
            const median = row.medians[x + 1];
            return `<b>${row.label}</b><br/>${shownYears[x]} : ${v === '-' ? 'pas assez de ventes' : changeFormat(v)}${
              median != null ? `<br/>Médiane ${Math.round(median).toLocaleString('fr-FR')} €/m²` : ''}`;
          },
        },
        xAxis: { type: 'category', data: shownYears, position: 'top', ...axisStyle(), splitArea: { show: false } },
        yAxis: {
          type: 'category',
          data: rows.map((r) => r.label),
          inverse: true,
          ...axisStyle(),
          axisLabel: { ...axisStyle().axisLabel, fontSize: 10, width: 140, overflow: 'truncate' },
        },
        visualMap: {
          type: 'continuous',
          min: -CHANGE_RANGE,
          max: CHANGE_RANGE,
          calculable: false,
          dimension: 3,
          orient: 'vertical',
          right: 4,
          top: 'middle',
          itemHeight: 140,
          itemWidth: 10,
          text: ['+10 %', '−10 %'],
          textStyle: { color: css('--ink-3'), fontSize: 10 },
          inRange: { color: [css('--neg'), css('--surface-2'), css('--pos')] },
        },
        series: [
          {
            type: 'heatmap',
            data,
            cursor: onPick ? 'pointer' : 'default',
            itemStyle: { borderColor: css('--surface'), borderWidth: 1 },
            label: { show: rows.length <= 30, fontSize: 9, color: css('--ink-1'), formatter: (p: { data: [number, number, number | '-'] }) =>
              p.data[2] === '-' ? '' : changeFormat(p.data[2] as number) },
            emphasis: { itemStyle: { borderColor: css('--ink-1'), borderWidth: 1 } },
          },
        ],
      }}
    />
  );
};
