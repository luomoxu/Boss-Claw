// 招聘趋势图表（recharts）
// ---------------------------------------------------------------------------
// 两张图：
//   ① SupplyTrendChart：日粒度「新发现 vs 本期在架」双折线；缺失采集的日期 connectNulls=false 断开。
//   ② SalaryBandChart：月薪 P25–P75 带状区间 + P50 中位线；样本 < 3 的日期留空。
// 颜色全部取主题 CSS 变量，浅色 / 深色模式同一套代码。
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { TrendPoint } from '@/lib/bossclaw/trendAggregate';

const AXIS_TICK = { fill: 'var(--fg-subtle)', fontSize: 11 };
const TOOLTIP_STYLE = {
  background: 'var(--card-bg)',
  border: '1px solid var(--border)',
  borderRadius: 8,
  color: 'var(--fg)',
  fontSize: 12,
  boxShadow: 'var(--shadow-sm)',
};

interface TipPayload {
  payload?: TrendPoint;
}

function SupplyTooltip({ active, payload }: { active?: boolean; payload?: TipPayload[] }) {
  const p = payload?.[0]?.payload;
  if (!active || !p) return null;
  if (p.newCount == null && p.activeCount == null) {
    return <div style={TOOLTIP_STYLE} className="trend-tip">当日无采集覆盖</div>;
  }
  return (
    <div style={TOOLTIP_STYLE} className="trend-tip">
      <div className="trend-tip-title">{p.date}</div>
      <div>新发现：<b>{p.newCount ?? '—'}</b></div>
      <div>本期在架：<b>{p.activeCount ?? '—'}</b></div>
      <div>公司数：<b>{p.companyCount ?? '—'}</b></div>
    </div>
  );
}

export function SupplyTrendChart({ points }: { points: TrendPoint[] }) {
  return (
    <div className="trend-chart-box">
      <ResponsiveContainer width="100%" height={260}>
        <ComposedChart data={points} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" />
          <XAxis dataKey="label" tick={AXIS_TICK} tickLine={false} axisLine={{ stroke: 'var(--border)' }} interval="preserveStartEnd" minTickGap={24} />
          <YAxis tick={AXIS_TICK} tickLine={false} axisLine={false} width={34} allowDecimals={false} />
          <Tooltip content={<SupplyTooltip />} />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Line
            type="monotone"
            dataKey="newCount"
            name="新发现"
            stroke="var(--brand)"
            strokeWidth={2}
            dot={false}
            connectNulls={false}
          />
          <Line
            type="monotone"
            dataKey="activeCount"
            name="本期在架"
            stroke="var(--status-warning)"
            strokeWidth={1.5}
            strokeDasharray="5 4"
            dot={false}
            connectNulls={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

function SalaryTooltip({ active, payload }: { active?: boolean; payload?: TipPayload[] }) {
  const p = payload?.[0]?.payload;
  if (!active || !p) return null;
  if (p.salaryP50 == null) {
    return <div style={TOOLTIP_STYLE} className="trend-tip">当日有效薪资样本不足 3 条</div>;
  }
  return (
    <div style={TOOLTIP_STYLE} className="trend-tip">
      <div className="trend-tip-title">{p.date}</div>
      <div>P25：<b>{p.salaryP25 ?? '—'}K</b></div>
      <div>中位：<b>{p.salaryP50 ?? '—'}K</b></div>
      <div>P75：<b>{p.salaryP75 ?? '—'}K</b></div>
      <div>样本：{p.salarySamples} 条</div>
    </div>
  );
}

export function SalaryBandChart({ points }: { points: TrendPoint[] }) {
  const data = points.map((p) => ({
    ...p,
    bandBase: p.salaryP25,
    bandRange: p.salaryP25 != null && p.salaryP75 != null ? Math.max(0, p.salaryP75 - p.salaryP25) : null,
  }));
  return (
    <div className="trend-chart-box">
      <ResponsiveContainer width="100%" height={240}>
        <ComposedChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" />
          <XAxis dataKey="label" tick={AXIS_TICK} tickLine={false} axisLine={{ stroke: 'var(--border)' }} interval="preserveStartEnd" minTickGap={24} />
          <YAxis tick={AXIS_TICK} tickLine={false} axisLine={false} width={38} unit="K" />
          <Tooltip content={<SalaryTooltip />} />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Area type="monotone" dataKey="bandBase" stackId="band" stroke="none" fill="transparent" legendType="none" name="" isAnimationActive={false} />
          <Area
            type="monotone"
            dataKey="bandRange"
            stackId="band"
            name="P25–P75"
            stroke="none"
            fill="var(--brand)"
            fillOpacity={0.16}
            connectNulls={false}
            isAnimationActive={false}
          />
          <Line
            type="monotone"
            dataKey="salaryP50"
            name="中位月薪"
            stroke="var(--brand)"
            strokeWidth={2}
            dot={false}
            connectNulls={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
