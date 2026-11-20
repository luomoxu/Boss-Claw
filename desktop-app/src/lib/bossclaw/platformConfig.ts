// 平台级配置覆盖（全局设置 + 平台个性化）
// ---------------------------------------------------------------------------
// 背景：无关键字采集、滚动轮数、采集节奏、标题筛选等设置原先只有全局一份，但不同平台的搜索
// 形态不同（BOSS 推荐流不带关键词，猎聘/智联仍按投递方向关键词搜索；各平台页面重量也决定了
// 加载等待上限不同）。这里提供统一的「全局 + 平台覆盖」解析规则：
//   - 平台显式设置过的字段 → 覆盖全局；
//   - 未设置（undefined）→ 跟随全局；
//   - 以后新增的可覆盖字段只需改 PLATFORM_OVERRIDE_FIELDS 与 PlatformCollectOverride。
//
// 只覆盖「搜索采集」相关字段：投递节奏 / 安全阈值 / 平台启用状态等仍为全局，
// 避免平台间出现难以理解的行为差异。
import type { AppConfig, JobPlatform, PlatformCollectOverride } from './types';

/** 允许按平台覆盖的字段（UI 与合并逻辑共用同一份清单） */
export const PLATFORM_OVERRIDE_FIELDS = [
  'collectWithoutKeyword',
  'listAutoScroll',
  'listScrollRounds',
  'collectSpeedMs',
  'collectPageTimeoutMs',
  'listScanMax',
  'recommendTabMax',
  'recommendTabSwitchMs',
  'titleScreenEnabled',
  'titleScreenBatchSize',
  'skipContactedJobs',
  'seenJobsTtlDays',
  'maxJobsPerRun',
] as const satisfies readonly (keyof PlatformCollectOverride)[];

/** 某平台的覆盖项（无覆盖时返回空对象，便于 UI 读取） */
export function platformCollectOverrides(
  config: AppConfig,
  platform: JobPlatform
): PlatformCollectOverride {
  return config.platformCollect?.[platform] || {};
}

/** 该平台是否配置了任意覆盖（UI 摘要用） */
export function hasPlatformOverrides(config: AppConfig, platform: JobPlatform): boolean {
  const ov = config.platformCollect?.[platform];
  if (!ov) return false;
  return PLATFORM_OVERRIDE_FIELDS.some((key) => ov[key] !== undefined);
}

/**
 * 解析「该平台实际生效的配置」：把所有显式覆盖项合并到全局配置上。
 * 不修改入参；没有任何覆盖时直接返回原对象（避免无意义的对象分配）。
 */
export function configForPlatform(config: AppConfig, platform: JobPlatform): AppConfig {
  const ov = config.platformCollect?.[platform];
  if (!ov) return config;
  const patch: Record<string, unknown> = {};
  for (const key of PLATFORM_OVERRIDE_FIELDS) {
    const value = ov[key];
    if (value !== undefined) patch[key] = value;
  }
  return Object.keys(patch).length ? ({ ...config, ...patch } as AppConfig) : config;
}

/**
 * 生成「设置某平台的一个覆盖项」所需的 config patch（供设置页 setConfig 使用）。
 * value 传 undefined 表示清除该项（回到跟随全局）；清空后该平台不再保留空对象。
 */
export function setPlatformOverride(
  config: AppConfig,
  platform: JobPlatform,
  key: keyof PlatformCollectOverride,
  value: boolean | number | undefined
): Partial<AppConfig> {
  const all = { ...(config.platformCollect || {}) };
  const next: PlatformCollectOverride = { ...(all[platform] || {}) };
  if (value === undefined) delete next[key];
  else (next as Record<string, unknown>)[key] = value;
  if (Object.keys(next).length) all[platform] = next;
  else delete all[platform];
  return { platformCollect: all };
}
