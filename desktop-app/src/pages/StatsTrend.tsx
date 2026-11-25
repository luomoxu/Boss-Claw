// 数据统计 · 招聘趋势 Tab
// ---------------------------------------------------------------------------
// 数据源：采集事件库（collectEvents.ts，BOSS / 猎聘自动采集）→ trendAggregate 纯函数聚合。
// 页面只做三件事：筛选、展示、按需请求 AI 解读。
// 本地规则结论（insights）永远先给；AI 解读失败不影响页面可用。
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Button,
  Card,
  Empty,
  Segmented,
  Select,
  Space,
  Spin,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd';
import {
  BulbOutlined,
  CloudSyncOutlined,
  ExperimentOutlined,
  ReloadOutlined,
  RiseOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { useDataStore } from '@/store/useDataStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import {
  DEFAULT_TREND_FILTERS,
  TREND_BASIS_OPTIONS,
  TREND_RANGES,
  buildTrendSnapshot,
  trendFilterOptions,
  type TrendFilters,
  type TrendRankRow,
} from '@/lib/bossclaw/trendAggregate';
import {
  collectEventsUsage,
  loadCollectEvents,
  type CollectEvent,
  type CollectEventUsage,
} from '@/lib/bossclaw/collectEvents';
import { generateTrendInsight } from '@/lib/bossclaw/trendInsight';
import { SupplyTrendChart, SalaryBandChart } from '@/components/TrendChart';

const { Text } = Typography;

const toneClass: Record<string, string> = {
  info: 'trend-insight-card--info',
  good: 'trend-insight-card--good',
  warn: 'trend-insight-card--warn',
};

function fmtK(v: number | null | undefined): string {
  return v == null ? '—' : `${v}K`;
}
function pct(v: number): string {
  return `${Math.round(v * 100)}%`;
}

function RankList({ rows, unit = '个', emptyText = '暂无数据' }: { rows: TrendRankRow[]; unit?: string; emptyText?: string }) {
  if (!rows.length) return <Text type="secondary" style={{ fontSize: 12 }}>{emptyText}</Text>;
  const max = Math.max(...rows.map((r) => r.count), 1);
  return (
    <div className="trend-rank-list">
      {rows.map((r) => (
        <div className="trend-rank-row" key={r.name}>
          <div className="trend-rank-head">
            <span className="trend-rank-name" title={r.name}>{r.name}</span>
            <span className="trend-rank-value">
              {r.count} {unit}
              <em>{pct(r.share)}</em>
            </span>
          </div>
          <div className="trend-rank-bar">
            <span style={{ width: `${Math.max(2, (r.count / max) * 100)}%` }} />
          </div>
          {r.medianSalary != null && <div className="trend-rank-sub">月薪中位 {r.medianSalary}K</div>}
        </div>
      ))}
    </div>
  );
}

export default function StatsTrend() {
  const pending = useDataStore((s) => s.pending);
  const directionPlan = useDataStore((s) => s.directionPlan);
  const profile = useDataStore((s) => s.profile);
  const config = useSettingsStore((s) => s.config);

  const [filters, setFilters] = useState<TrendFilters>(DEFAULT_TREND_FILTERS);
  const [events, setEvents] = useState<CollectEvent[]>([]);
  const [usage, setUsage] = useState<CollectEventUsage | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [aiText, setAiText] = useState('');
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState('');

  const reload = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    const from = Date.now() - 365 * 86400000;
    const [list, use] = await Promise.all([loadCollectEvents(from), collectEventsUsage()]);
    setEvents(list);
    setUsage(use);
    if (!list.length && !use) setLoadError('事件库不可用（当前可能运行在浏览器预览模式）');
    setLoading(false);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const options = useMemo(() => trendFilterOptions(events, directionPlan), [events, directionPlan]);
  const snapshot = useMemo(
    () => buildTrendSnapshot({ events, pending, directionPlan, filters }),
    [events, pending, directionPlan, filters]
  );

  const setFilter = (patch: Partial<TrendFilters>) => {
    setFilters((f) => ({ ...f, ...patch }));
    // 筛选变化后旧 AI 解读不再适用（缓存 key 也会变，但界面先清掉避免误读）
    setAiText('');
    setAiError('');
  };

  const runAI = useCallback(async () => {
    if (aiLoading) return;
    setAiLoading(true);
    setAiError('');
    const res = await generateTrendInsight(snapshot, profile, config);
    if (res.ok && res.text) setAiText(res.text);
    else {
      setAiError(res.error || 'AI 解读失败');
      message.warning(`AI 解读未生成：${res.error || '未知原因'}`);
    }
    setAiLoading(false);
  }, [aiLoading, snapshot, profile, config]);

  if (loading) {
    return (
      <Card>
        <div className="stats-empty" style={{ padding: '64px 0' }}>
          <Spin />
          <p className="stats-empty-desc" style={{ marginTop: 12 }}>正在读取本地采集事件库…</p>
        </div>
      </Card>
    );
  }

  if (loadError) {
    return (
      <Card>
        <Empty description={loadError} />
      </Card>
    );
  }

  if (!events.length) {
    return (
      <Card>
        <div className="stats-empty">
          <div className="stats-empty-icon"><RiseOutlined /></div>
          <h2 className="stats-empty-title">采集事件库还没有数据</h2>
          <p className="stats-empty-desc">
            招聘趋势只统计「自动采集扫到的岗位」（BOSS / 猎聘），从本次升级后开始记录，不回溯历史。
            去工作台跑一次搜索采集，这里就会出现供给量、薪资分位和筛选漏斗。
          </p>
          <div className="stats-empty-actions">
            <Button type="primary" icon={<ReloadOutlined />} onClick={() => void reload()}>刷新</Button>
          </div>
        </div>
      </Card>
    );
  }

  const maxFunnel = Math.max(1, ...snapshot.funnel.map((f) => f.value));
  const delta = snapshot.summary.newPrevPeriod > 0
    ? Math.round(((snapshot.summary.newLastPeriod - snapshot.summary.newPrevPeriod) / snapshot.summary.newPrevPeriod) * 100)
    : null;

  return (
    <div className="trend-page">
      {/* 筛选 */}
      <Card size="small" className="trend-filter-card">
        <div className="trend-filter-row">
          <Segmented
            value={filters.range}
            onChange={(v) => setFilter({ range: v as TrendFilters['range'] })}
            options={TREND_RANGES.map((r) => ({ label: r.label, value: r.key }))}
          />
          <Select
            value={filters.platform}
            onChange={(v) => setFilter({ platform: v })}
            options={[
              { label: '全部平台', value: 'all' },
              { label: 'BOSS', value: 'boss' },
              { label: '猎聘', value: 'liepin' },
            ]}
            style={{ width: 120 }}
          />
          <Select
            value={filters.city || ''}
            onChange={(v) => setFilter({ city: v })}
            options={[{ label: '全部城市', value: '' }, ...options.cities.map((c) => ({ label: c, value: c }))]}
            style={{ width: 140 }}
          />
          <Select
            value={filters.direction || ''}
            onChange={(v) => setFilter({ direction: v })}
            options={[{ label: '全部方向', value: '' }, ...options.directions.map((d) => ({ label: d, value: d }))]}
            style={{ width: 170 }}
          />
          <Select
            value={filters.basis}
            onChange={(v) => setFilter({ basis: v })}
            options={TREND_BASIS_OPTIONS}
            style={{ width: 200 }}
          />
          <Tooltip title="重新读取事件库（采集结束后无需重启应用）">
            <Button size="small" icon={<ReloadOutlined />} onClick={() => void reload()}>刷新</Button>
          </Tooltip>
          <span className="trend-filter-meta">
            {snapshot.rangeLabel} · {usage ? `${usage.count} 条事件 / ${(usage.bytes / 1024).toFixed(0)} KB` : ''}
          </span>
        </div>
      </Card>

      {/* 总览 */}
      <div className="stat-cards-grid trend-summary-grid">
        <div className="stat-card stat-card-teal">
          <div className="stat-card-spine" />
          <div className="stat-card-content">
            <div className="stat-card-header"><div className="stat-icon teal"><RiseOutlined /></div></div>
            <div className="stat-body">
              <div className="stat-title">范围内岗位</div>
              <div className="stat-value">{snapshot.summary.total}</div>
              <div className="stat-note">按 jobId 去重 · 新发现 {snapshot.summary.newInRange}</div>
            </div>
          </div>
        </div>
        <div className="stat-card stat-card-green">
          <div className="stat-card-spine" />
          <div className="stat-card-content">
            <div className="stat-card-header"><div className="stat-icon green"><CloudSyncOutlined /></div></div>
            <div className="stat-body">
              <div className="stat-title">新发现趋势</div>
              <div className="stat-value">{delta == null ? '—' : `${delta >= 0 ? '+' : ''}${delta}%`}</div>
              <div className="stat-note">近 14 天 {snapshot.summary.newLastPeriod} vs 前 14 天 {snapshot.summary.newPrevPeriod}</div>
            </div>
          </div>
        </div>
        <div className="stat-card stat-card-purple">
          <div className="stat-card-spine" />
          <div className="stat-card-content">
            <div className="stat-card-header"><div className="stat-icon purple"><ThunderboltOutlined /></div></div>
            <div className="stat-body">
              <div className="stat-title">月薪中位</div>
              <div className="stat-value">{fmtK(snapshot.summary.salaryMedian)}</div>
              <div className="stat-note">P25 {fmtK(snapshot.summary.salaryP25)} / P75 {fmtK(snapshot.summary.salaryP75)} · 覆盖 {pct(snapshot.coverage.salaryCoverage)}</div>
            </div>
          </div>
        </div>
        <div className="stat-card stat-card-blue">
          <div className="stat-card-spine" />
          <div className="stat-card-content">
            <div className="stat-card-header"><div className="stat-icon blue"><ExperimentOutlined /></div></div>
            <div className="stat-body">
              <div className="stat-title">公司与热度</div>
              <div className="stat-value">{snapshot.summary.companies}</div>
              <div className="stat-note">多 HR 岗 {snapshot.summary.multiHrJobs} · 重复遇见 {pct(snapshot.summary.repeatRate)}</div>
            </div>
          </div>
        </div>
      </div>

      {/* 本地规则结论 */}
      <div className="trend-insight-grid">
        {snapshot.insights.map((it) => (
          <div className={`trend-insight-card ${toneClass[it.tone] || ''}`} key={it.title}>
            <div className="trend-insight-title"><BulbOutlined /> {it.title}</div>
            <div className="trend-insight-body">{it.body}</div>
          </div>
        ))}
      </div>

      {/* 供给趋势 */}
      <Card
        size="small"
        title="供给趋势（日粒度）"
        extra={<Text type="secondary" style={{ fontSize: 12 }}>新发现按{filters.basis === 'publish' ? '发布时间（缺失回退首次采集）' : '首次采集时间'}；断点 = 当日无采集覆盖</Text>}
      >
        <SupplyTrendChart points={snapshot.points} />
      </Card>

      {/* 薪资带 */}
      <Card
        size="small"
        title="月薪分位（P25–P75 带状）"
        extra={<Text type="secondary" style={{ fontSize: 12 }}>只统计可解析的月薪基数；样本 &lt; 3 的日期留空</Text>}
      >
        <SalaryBandChart points={snapshot.points} />
      </Card>

      {/* 筛选漏斗 + 流失原因 */}
      <div className="stats-row stats-row--2">
        <Card size="small" title="筛选漏斗" extra={<Text type="secondary" style={{ fontSize: 12 }}>扫描量 {snapshot.funnel[0]?.value ?? 0}</Text>}>
          <div className="trend-funnel">
            {snapshot.funnel.map((f, i) => (
              <div className="trend-funnel-row" key={f.key}>
                <span className="trend-funnel-label">{f.label}</span>
                <div className="trend-funnel-track">
                  <span className="trend-funnel-fill" style={{ width: `${(f.value / maxFunnel) * 100}%` }} />
                </div>
                <span className="trend-funnel-value">
                  {f.value}
                  <em>{pct(f.ofTotal)}</em>
                  {i > 0 && f.lostFromPrev > 0 && <b className="trend-funnel-loss">−{f.lostFromPrev}</b>}
                </span>
              </div>
            ))}
          </div>
          <Text type="secondary" style={{ fontSize: 12 }}>
            已投递会把队列中的 sentAt 并进漏斗；事件库自身只记录采集阶段。
          </Text>
        </Card>
        <Card size="small" title="主要流失原因" extra={<Text type="secondary" style={{ fontSize: 12 }}>Top {snapshot.reasons.length}</Text>}>
          <RankList rows={snapshot.reasons.map((r) => ({ name: r.label, count: r.count, share: snapshot.summary.total ? r.count / snapshot.summary.total : 0, medianSalary: null }))} emptyText="暂无排除记录" />
        </Card>
      </div>

      {/* 方向 / 职级 / 技术标签 */}
      <div className="stats-row stats-row--3">
        <Card size="small" title="方向分布" extra={<Text type="secondary" style={{ fontSize: 12 }}>采集方向 + 标题规则匹配</Text>}>
          <RankList rows={snapshot.directions} emptyText="暂无方向数据" />
        </Card>
        <Card size="small" title="职级分布" extra={<Text type="secondary" style={{ fontSize: 12 }}>按标题粗分</Text>}>
          <RankList rows={snapshot.levels} emptyText="暂无职级数据" />
        </Card>
        <Card size="small" title="技术关键词" extra={<Text type="secondary" style={{ fontSize: 12 }}>标题 + 卡片 + JD</Text>}>
          <RankList rows={snapshot.techTags} unit="次" emptyText="暂无技术标签" />
        </Card>
      </div>

      {/* 团队规模 / HR 活跃度 / 多 HR 热岗 */}
      <div className="stats-row stats-row--3">
        <Card size="small" title="团队规模" extra={<Text type="secondary" style={{ fontSize: 12 }}>只认 JD 明确数字</Text>}>
          <RankList rows={snapshot.teamSizes} emptyText="JD 未披露团队规模" />
        </Card>
        <Card size="small" title="HR 活跃度" extra={<Text type="secondary" style={{ fontSize: 12 }}>采集时页面文本</Text>}>
          <RankList rows={snapshot.hrActivity} emptyText="暂无活跃度数据" />
        </Card>
        <Card size="small" title="多 HR / 重复招聘" extra={<Text type="secondary" style={{ fontSize: 12 }}>同公司同标题不同 jobId</Text>}>
          {snapshot.hotJobs.length ? (
            <div className="trend-hot-list">
              {snapshot.hotJobs.slice(0, 6).map((h) => (
                <div className="trend-hot-row" key={`${h.company}-${h.title}`}>
                  <div className="trend-hot-main">
                    <span className="trend-hot-title" title={h.title}>{h.title}</span>
                    <span className="trend-hot-company" title={h.company}>{h.company || '—'} · {h.city || '—'}</span>
                  </div>
                  <Space size={4}>
                    {h.jobCount > 1 && <Tag color="orange">{h.jobCount} 个岗位</Tag>}
                    <Tag>{h.scanCount} 次</Tag>
                  </Space>
                </div>
              ))}
            </div>
          ) : (
            <Text type="secondary" style={{ fontSize: 12 }}>暂无重复招聘信号</Text>
          )}
        </Card>
      </div>

      {/* AI 解读 */}
      <Card
        size="small"
        title={<span><BulbOutlined /> AI 趋势解读</span>}
        extra={
          <Button size="small" type="primary" loading={aiLoading} onClick={() => void runAI()}>
            {aiText ? '重新生成' : '生成趋势解读'}
          </Button>
        }
      >
        {aiText ? (
          <div className="trend-ai-text">
            {aiText.split('\n').map((line, i) => (
              // key 用「行号 + 原文」：AI 文本重复行常见，单用行号在下标变化时会串位
              // （见 scripts/jsx-key-regression.mjs 守卫）
              <p key={`${i}-${line}`}>{line.replace(/^[-*]\s*/, '')}</p>
            ))}
            <Text type="secondary" style={{ fontSize: 12 }}>
              由本地聚合数据 + 当前 trend-insight 技能生成；结果缓存 24 小时，数据变化后才会重新计费。
            </Text>
          </div>
        ) : aiError ? (
          <Text type="danger" style={{ fontSize: 12 }}>{aiError}</Text>
        ) : (
          <Text type="secondary" style={{ fontSize: 12 }}>
            按需调用大模型，把上方聚合指标转成 3–5 条行动建议；不会自动调用，也不上传原始岗位列表。
          </Text>
        )}
      </Card>
    </div>
  );
}
