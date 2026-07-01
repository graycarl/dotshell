/**
 * /quota 命令 - 查询各 AI 提供商的账户余额/配额
 *
 * 支持的 Provider:
 *   - anthropic      ✅ 订阅用量 + Extra Usage 查询（需 OAuth 订阅认证）
 *   - deepseek       ✅ 余额查询（人民币）
 *   - github-copilot ✅ 配额查询（Premium Requests / 月）
 *   - kimi-coding    ✅ 配额查询（Kimi Code /usage）
 *   - zai-coding-cn  ✅ 余额查询（ZAI Coding 中国版 / BigModel）
 *   - ...            🔲 待实现
 *
 * 安装位置: ~/.pi/agent/extensions/quota.ts
 * 使用 /reload 或重启 pi 后生效
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

// ===================================================================
//  类型定义
// ===================================================================

/** 单个 Provider 的余额/配额结果 */
interface QuotaResult {
  provider: string;
  label: string;
  available: boolean;
  balances: BalanceItem[];
  error?: string;
}

interface BalanceItem {
  currency: string;
  totalBalance: string;
  used?: string;
  grantedBalance?: string;
  toppedUpBalance?: string;
  resetDate?: string;
  planName?: string;
  overagePermitted?: boolean;
  overageUsed?: string;
}

type QuotaFetcher = (apiKey: string) => Promise<QuotaResult>;

interface ProviderConfig {
  key: string;
  label: string;
  authKey: string;    // auth.json 中的 key
  authType: "api_key" | "cli" | "oauth" | "none";
  fetcher: QuotaFetcher;
}

// ===================================================================
//  DeepSeek 余额查询
// ===================================================================

const DEEPSEEK_BALANCE_URL = "https://api.deepseek.com/user/balance";

const fetchDeepSeekQuota: QuotaFetcher = async (apiKey: string) => {
  const res = await fetch(DEEPSEEK_BALANCE_URL, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }

  const data = (await res.json()) as {
    is_available: boolean;
    balance_infos: Array<{
      currency: string;
      total_balance: string;
      granted_balance: string;
      topped_up_balance: string;
    }>;
  };

  return {
    provider: "deepseek",
    label: "DeepSeek",
    available: data.is_available,
    balances: data.balance_infos.map((b) => ({
      currency: b.currency,
      totalBalance: b.total_balance,
      grantedBalance: b.granted_balance,
      toppedUpBalance: b.topped_up_balance,
    })),
  };
};

// ===================================================================
//  GitHub Copilot 配额查询
// ===================================================================
//
// 使用 `gh` CLI 的认证 token 调用 GitHub 内部 API：
//   GET https://api.github.com/copilot_internal/user
//
// 响应字段说明（以 Copilot Pro 为例）：
//   copilot_plan: "individual"
//   quota_reset_date: "2026-06-01"
//   quota_snapshots.premium_interactions: {
//     entitlement: 300,          // 每月配额总数
//     remaining: 253,            // 剩余次数
//     percent_remaining: 84.3,   // 剩余百分比
//     overage_permitted: true,   // 是否允许超额
//     overage_count: 0,          // 超额使用次数
//     unlimited: false           // 是否无限
//   }
//
// 注意：这里的配额指的是 "premium requests"（高级请求），
// 包括 agent mode、更强大的模型调用等。普通 chat 和
// 代码补全通常是 unlimited。

const GITHUB_COPILOT_API = "https://api.github.com/copilot_internal/user";

const PLAN_LABELS: Record<string, string> = {
  free: "Copilot Free",
  individual: "Copilot Pro",
  individual_pro: "Copilot Pro+",
  business: "Copilot Business",
  enterprise: "Copilot Enterprise",
};

const fetchGitHubCopilotQuota: QuotaFetcher = async () => {
  // 获取 gh CLI 的认证 token
  let token: string;
  try {
    token = execSync("gh auth token", {
      encoding: "utf-8",
      timeout: 10_000,
    }).trim();
  } catch {
    throw new Error(
      "无法获取 GitHub token。请确保已安装 gh CLI 并通过 `gh auth login` 登录。"
    );
  }

  const res = await fetch(GITHUB_COPILOT_API, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "User-Agent": "pi-quota-extension/1.0",
    },
  });

  if (res.status === 401) {
    throw new Error("认证失败 (401)，请重新运行 `gh auth login`");
  }
  if (res.status === 403) {
    throw new Error("权限不足 (403)，token 缺少必要的 scope");
  }
  if (res.status === 404) {
    throw new Error("Copilot 未启用或 API 不可用 (404)");
  }
  if (res.status === 429) {
    throw new Error("请求过于频繁，已被限速 (429)");
  }
  if (!res.ok) {
    throw new Error(`API 错误: HTTP ${res.status}`);
  }

  const data = (await res.json()) as {
    login: string;
    copilot_plan?: string;
    quota_reset_date?: string;
    access_type_sku?: string;
    quota_snapshots?: {
      premium_interactions?: {
        entitlement: number;
        remaining: number;
        percent_remaining: number;
        unlimited: boolean;
        overage_permitted: boolean;
        overage_count: number;
      };
      chat?: {
        unlimited: boolean;
        remaining: number;
      };
      completions?: {
        unlimited: boolean;
        remaining: number;
      };
    };
  };

  const planName = PLAN_LABELS[data.copilot_plan ?? ""] ?? data.copilot_plan ?? "未知";
  const pi = data.quota_snapshots?.premium_interactions;
  const entitlements: BalanceItem[] = [];

  // —— Premium Interactions（主要配额） ——
  if (pi) {
    if (pi.unlimited) {
      entitlements.push({
        currency: "Premium Requests",
        totalBalance: "∞ 无限",
        planName,
        resetDate: data.quota_reset_date,
      });
    } else {
      const used = Math.round(pi.entitlement - pi.remaining);
      const pct = Math.round((1 - pi.percent_remaining / 100) * 100);
      const total = `${used} / ${pi.entitlement} (${pct}%)`;
      const overageStr = pi.overage_permitted
        ? pi.overage_count > 0
          ? ` (含超额 ${pi.overage_count})`
          : " (已启用超额)"
        : "";

      entitlements.push({
        currency: "Premium Requests",
        totalBalance: total + overageStr,
        used: `${used}`,
        planName,
        resetDate: data.quota_reset_date,
        overagePermitted: pi.overage_permitted,
        overageUsed: pi.overage_count > 0 ? `${pi.overage_count}` : undefined,
      });
    }
  } else {
    entitlements.push({
      currency: "Premium Requests",
      totalBalance: "无 Premium 配额",
      planName,
    });
  }

  // —— Chat（通常无限） ——
  const chat = data.quota_snapshots?.chat;
  if (chat) {
    entitlements.push({
      currency: "Chat",
      totalBalance: chat.unlimited ? "∞ 无限" : `剩余 ${chat.remaining}`,
    });
  }

  // —— Completions（代码补全，通常无限） ——
  const completions = data.quota_snapshots?.completions;
  if (completions) {
    entitlements.push({
      currency: "Completions",
      totalBalance: completions.unlimited ? "∞ 无限" : `剩余 ${completions.remaining}`,
    });
  }

  return {
    provider: "github-copilot",
    label: `GitHub Copilot (${data.login})`,
    available: !!data.copilot_plan,
    balances: entitlements,
  };
};

// ===================================================================
//  Kimi Code 配额查询
// ===================================================================

const KIMI_CODE_USAGE_URL = "https://api.kimi.com/coding/v1/usages";

const KIMI_MEMBERSHIP_LABELS: Record<string, string> = {
  LEVEL_FREE: "Free",
  LEVEL_PRIMARY: "Primary",
  LEVEL_INTERMEDIATE: "Intermediate",
  LEVEL_ADVANCED: "Advanced",
  LEVEL_PRO: "Pro",
  LEVEL_ULTRA: "Ultra",
};

interface KimiUsageDetail {
  limit?: string | number;
  used?: string | number;
  remaining?: string | number;
  resetTime?: string;
  reset_at?: string;
  resetAt?: string;
}

interface KimiUsageResponse {
  usage?: KimiUsageDetail;
  limits?: Array<{
    name?: string;
    title?: string;
    detail?: KimiUsageDetail;
    window?: {
      duration?: number;
      timeUnit?: string;
    };
  }>;
  user?: {
    membership?: {
      level?: string;
    };
  };
}

function toNumberOrNull(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function formatKimiQuotaText(
  limitRaw: unknown,
  usedRaw: unknown,
  remainingRaw: unknown,
): { text: string; used?: string } {
  const limit = toNumberOrNull(limitRaw);
  let used = toNumberOrNull(usedRaw);
  const remaining = toNumberOrNull(remainingRaw);

  if (used === null && limit !== null && remaining !== null) {
    used = Math.max(limit - remaining, 0);
  }

  if (limit !== null && used !== null && limit > 0) {
    const usedInt = Math.round(used);
    const limitInt = Math.round(limit);
    const usedPct = Math.min(100, Math.max(0, Math.round((usedInt / limitInt) * 100)));
    const leftPct = Math.max(0, 100 - usedPct);
    return {
      text: `${usedInt} / ${limitInt} (${usedPct}% 已用, ${leftPct}% 剩余)`,
      used: `${usedInt}`,
    };
  }

  if (remaining !== null) {
    return { text: `剩余 ${Math.round(remaining)}` };
  }
  if (used !== null) {
    return { text: `已用 ${Math.round(used)}`, used: `${Math.round(used)}` };
  }

  return { text: "数据不可用" };
}

function formatKimiLimitLabel(
  window: { duration?: number; timeUnit?: string } | undefined,
  fallback: string,
): string {
  if (!window?.duration || !window?.timeUnit) return fallback;

  const duration = window.duration;
  const unit = window.timeUnit;

  if (unit.includes("MINUTE")) {
    if (duration >= 60 && duration % 60 === 0) {
      return `${duration / 60}h Limit`;
    }
    return `${duration}m Limit`;
  }
  if (unit.includes("HOUR")) return `${duration}h Limit`;
  if (unit.includes("DAY")) return `${duration}d Limit`;

  return fallback;
}

function pickResetTime(detail: KimiUsageDetail | undefined): string | undefined {
  if (!detail) return undefined;
  return detail.resetTime || detail.reset_at || detail.resetAt;
}

const fetchKimiCodeQuota: QuotaFetcher = async (apiKey: string) => {
  if (!apiKey) {
    throw new Error("未找到 Kimi API key，请先运行 /login 并选择 kimi");
  }

  const res = await fetch(KIMI_CODE_USAGE_URL, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
      "User-Agent": "pi-quota-extension/1.0",
    },
  });

  if (res.status === 401) {
    throw new Error("Kimi API key 无效或已过期，请重新运行 /login");
  }
  if (res.status === 403) {
    throw new Error("权限不足 (403)，无法访问 Kimi Code /usages");
  }
  if (res.status === 404) {
    throw new Error("Kimi Code /usages API 不可用 (404)");
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }

  const data = (await res.json()) as KimiUsageResponse;
  const balances: BalanceItem[] = [];

  const membershipLevel = data.user?.membership?.level;
  if (membershipLevel) {
    balances.push({
      currency: "Plan",
      totalBalance: `Kimi Code ${KIMI_MEMBERSHIP_LABELS[membershipLevel] ?? membershipLevel}`,
      planName: membershipLevel,
    });
  }

  if (data.usage) {
    const resetAt = pickResetTime(data.usage);
    const progress = formatKimiQuotaText(data.usage.limit, data.usage.used, data.usage.remaining);
    const reset = resetAt ? `  重置: ${formatTimeUntil(resetAt)}` : "";
    balances.push({
      currency: "Weekly Limit",
      totalBalance: `${progress.text}${reset}`,
      used: progress.used,
      resetDate: resetAt,
    });
  }

  for (const [idx, item] of (data.limits ?? []).entries()) {
    const detail = item.detail ?? (item as KimiUsageDetail);
    const label = formatKimiLimitLabel(item.window, `Limit #${idx + 1}`);
    const resetAt = pickResetTime(detail);
    const progress = formatKimiQuotaText(detail.limit, detail.used, detail.remaining);
    const reset = resetAt ? `  重置: ${formatTimeUntil(resetAt)}` : "";

    balances.push({
      currency: label,
      totalBalance: `${progress.text}${reset}`,
      used: progress.used,
      resetDate: resetAt,
    });
  }

  return {
    provider: "kimi-coding",
    label: "Kimi Code",
    available: balances.length > 0,
    balances,
  };
};

// ===================================================================
//  ZAI Coding 中国版 (BigModel) 余额查询
// ===================================================================

const ZAI_CODING_CN_BALANCE_URL =
  "https://open.bigmodel.cn/api/biz/account/query-customer-account-report";

interface ZaiCodingCnAccountResponse {
  code: number;
  msg: string;
  data: {
    balance: number;
    rechargeAmount: number;
    giveAmount: number;
    totalSpendAmount: number;
    todaySpendAmount?: number | null;
    availableBalance: number;
    frozenBalance: number;
    creditBalance?: number | null;
    availableCreditBalance?: number | null;
    creditStatus?: string;
    isKA?: boolean;
  };
  success: boolean;
}

const fetchZaiCodingCnQuota: QuotaFetcher = async (apiKey: string) => {
  if (!apiKey) {
    throw new Error(
      "未找到 ZAI Coding 中国版 API key，请先运行 /login 并选择 zai-coding-cn",
    );
  }

  const res = await fetch(ZAI_CODING_CN_BALANCE_URL, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
      "User-Agent": "pi-quota-extension/1.0",
    },
  });

  if (res.status === 401) {
    throw new Error(
      "ZAI Coding 中国版 API key 无效或已过期，请重新运行 /login",
    );
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }

  const json = (await res.json()) as ZaiCodingCnAccountResponse;

  if (!json.success || json.code !== 200) {
    throw new Error(json.msg || "ZAI Coding 中国版余额查询失败");
  }

  const d = json.data;
  const balances: BalanceItem[] = [
    {
      currency: "可用余额",
      totalBalance: `¥${d.availableBalance.toFixed(2)}`,
    },
    {
      currency: "总充值",
      totalBalance: `¥${d.rechargeAmount.toFixed(2)}`,
    },
    {
      currency: "总消费",
      totalBalance: `¥${d.totalSpendAmount.toFixed(2)}`,
    },
  ];

  if (d.giveAmount) {
    balances.push({
      currency: "赠送金",
      totalBalance: `¥${d.giveAmount.toFixed(2)}`,
    });
  }

  if (d.frozenBalance) {
    balances.push({
      currency: "冻结金额",
      totalBalance: `¥${d.frozenBalance.toFixed(2)}`,
    });
  }

  if (d.todaySpendAmount != null) {
    balances.push({
      currency: "今日消费",
      totalBalance: `¥${d.todaySpendAmount.toFixed(2)}`,
    });
  }

  return {
    provider: "zai-coding-cn",
    label: "ZAI Coding (China)",
    available: true,
    balances,
  };
};

// ===================================================================
//  Anthropic 订阅 Extra Usage 查询
// ===================================================================
//
// 使用 OAuth token 调用内部 API：
//   GET https://api.anthropic.com/api/oauth/usage
//
// 响应字段说明：
//   five_hour:         5 小时内的使用率
//   seven_day:         7 天总使用率（含所有模型）
//   seven_day_opus:    7 天 Opus 使用率
//   seven_day_sonnet:  7 天 Sonnet 使用率
//   extra_usage:       Extra Usage（超额使用）信息
//     is_enabled:      是否启用
//     monthly_limit:   月度限额（null 表示无限）
//     used_credits:    已使用金额（美元）
//     utilization:     使用率
//     currency:        货币单位
//     disabled_reason: 禁用原因

const ANTHROPIC_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const ANTHROPIC_PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";

interface AnthropicUsageResponse {
  five_hour: {
    utilization: number;
    resets_at: string | null;
  };
  seven_day: {
    utilization: number;
    resets_at: string | null;
  };
  seven_day_oauth_apps: {
    utilization: number;
    resets_at: string | null;
  } | null;
  seven_day_opus: {
    utilization: number;
    resets_at: string | null;
  } | null;
  seven_day_sonnet: {
    utilization: number;
    resets_at: string | null;
  } | null;
  seven_day_cowork: {
    utilization: number;
    resets_at: string | null;
  } | null;
  extra_usage: {
    is_enabled: boolean;
    monthly_limit: number | null;
    used_credits: number;
    utilization: number | null;
    currency: string;
    disabled_reason: string | null;
  } | null;
}

interface AnthropicProfileResponse {
  account: {
    uuid: string;
    full_name: string;
    display_name: string;
    email: string;
    has_claude_max: boolean;
    has_claude_pro: boolean;
  };
  organization: {
    uuid: string;
    name: string;
    organization_type: string;
    billing_type: string;
    rate_limit_tier: string;
    has_extra_usage_enabled: boolean;
    subscription_status: string;
  };
}

/** 格式化使用率为进度条 */
function formatUtilizationBar(utilization: number): string {
  const pct = Math.round(utilization * 100);
  const barLen = 20;
  const filled = Math.round(utilization * barLen);
  const bar = "█".repeat(filled) + "░".repeat(barLen - filled);
  return `[${bar}] ${pct}%`;
}

/** 格式化时间差 */
function formatTimeUntil(dateStr: string): string {
  const now = Date.now();
  const target = new Date(dateStr).getTime();
  const diff = target - now;
  if (diff <= 0) return "已重置";
  const hours = Math.floor(diff / 3600000);
  const minutes = Math.floor((diff % 3600000) / 60000);
  if (hours > 24) {
    const days = Math.floor(hours / 24);
    const remainHours = hours % 24;
    return `${days} 天 ${remainHours} 小时后`;
  }
  return hours > 0 ? `${hours} 小时 ${minutes} 分钟后` : `${minutes} 分钟后`;
}

const fetchAnthropicQuota: QuotaFetcher = async (accessToken: string) => {
  // 获取 profile 信息
  let profileLabel = "Anthropic";
  let orgName = "";
  let planType = "";
  try {
    const profileRes = await fetch(ANTHROPIC_PROFILE_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (profileRes.ok) {
      const profile = (await profileRes.json()) as AnthropicProfileResponse;
      profileLabel = `Anthropic (${profile.account.display_name})`;
      orgName = profile.organization.name;
      const orgType = profile.organization.organization_type;
      const billingType = profile.organization.billing_type;
      if (profile.account.has_claude_max) planType = "Claude Max";
      else if (profile.account.has_claude_pro) planType = "Claude Pro";
      else if (orgType === "claude_team") planType = "Claude Team";
      else planType = orgType;
    }
  } catch {
    // Profile 查询失败不影响主流程
  }

  // 获取 usage 信息
  const res = await fetch(ANTHROPIC_USAGE_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (res.status === 401) {
    throw new Error("OAuth token 已过期，请重新运行 /login");
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }

  const data = (await res.json()) as AnthropicUsageResponse;
  const balances: BalanceItem[] = [];

  // —— Plan 信息 ——
  if (planType || orgName) {
    balances.push({
      currency: "Plan",
      totalBalance: [planType, orgName].filter(Boolean).join(" / "),
      planName: planType,
    });
  }

  // —— 5 小时使用率 ——
  const fiveHourPct = Math.round(data.five_hour.utilization * 100);
  const fiveHourBar = formatUtilizationBar(data.five_hour.utilization);
  const fiveHourReset = data.five_hour.resets_at
    ? `  重置: ${formatTimeUntil(data.five_hour.resets_at)}`
    : "";
  balances.push({
    currency: "5h Rate Limit",
    totalBalance: `${fiveHourBar}${fiveHourReset}`,
    resetDate: data.five_hour.resets_at ?? undefined,
  });

  // —— 7 天总使用率 ——
  const sevenDayPct = Math.round(data.seven_day.utilization * 100);
  const sevenDayBar = formatUtilizationBar(data.seven_day.utilization);
  const sevenDayReset = data.seven_day.resets_at
    ? `  重置: ${formatTimeUntil(data.seven_day.resets_at)}`
    : "";
  balances.push({
    currency: "7d Usage",
    totalBalance: `${sevenDayBar}${sevenDayReset}`,
    resetDate: data.seven_day.resets_at ?? undefined,
  });

  // —— 7 天 Opus / Sonnet 分项 ——
  if (data.seven_day_opus) {
    const bar = formatUtilizationBar(data.seven_day_opus.utilization);
    const reset = data.seven_day_opus.resets_at
      ? `  重置: ${formatTimeUntil(data.seven_day_opus.resets_at)}`
      : "";
    balances.push({
      currency: "7d Opus",
      totalBalance: `${bar}${reset}`,
    });
  }
  if (data.seven_day_sonnet) {
    const bar = formatUtilizationBar(data.seven_day_sonnet.utilization);
    const reset = data.seven_day_sonnet.resets_at
      ? `  重置: ${formatTimeUntil(data.seven_day_sonnet.resets_at)}`
      : "";
    balances.push({
      currency: "7d Sonnet",
      totalBalance: `${bar}${reset}`,
    });
  }

  // —— Extra Usage ——
  if (data.extra_usage) {
    const eu = data.extra_usage;
    if (eu.is_enabled) {
      const used = `$${eu.used_credits.toFixed(2)} ${eu.currency}`;
      const limit = eu.monthly_limit !== null
        ? ` / $${eu.monthly_limit.toFixed(2)} 月限额`
        : " (无月度限额)";
      balances.push({
        currency: "Extra Usage",
        totalBalance: `${used}${limit}`,
        used: `$${eu.used_credits.toFixed(2)}`,
      });
    } else {
      const reason = eu.disabled_reason ? ` (${eu.disabled_reason})` : "";
      balances.push({
        currency: "Extra Usage",
        totalBalance: `未启用${reason}`,
      });
    }
  }

  return {
    provider: "anthropic",
    label: profileLabel,
    available: true,
    balances,
  };
};

// ===================================================================
//  Provider 注册表
// ===================================================================
//
// 添加新的 Provider：在此数组中增加一项即可。
// authType 说明：
//   "api_key" - 从 auth.json 读取 API key
//   "cli"     - 通过命令行工具获取认证（如 gh）
//   "oauth"   - 从 auth.json 读取 OAuth token
//   "none"    - 由 fetcher 自行处理认证信息

const PROVIDERS: ProviderConfig[] = [
  {
    key: "anthropic",
    label: "Anthropic",
    authKey: "anthropic",
    authType: "oauth",
    fetcher: fetchAnthropicQuota,
  },
  {
    key: "deepseek",
    label: "DeepSeek",
    authKey: "deepseek",
    authType: "api_key",
    fetcher: fetchDeepSeekQuota,
  },
  {
    key: "github-copilot",
    label: "GitHub Copilot",
    authKey: "github-copilot",
    authType: "cli",
    fetcher: fetchGitHubCopilotQuota,
  },
  {
    key: "kimi-coding",
    label: "Kimi Code",
    authKey: "kimi-coding",
    authType: "api_key",
    fetcher: fetchKimiCodeQuota,
  },
  {
    key: "zai-coding-cn",
    label: "ZAI Coding (China)",
    authKey: "zai-coding-cn",
    authType: "api_key",
    fetcher: fetchZaiCodingCnQuota,
  },
];

// ===================================================================
//  工具函数
// ===================================================================

/** 从 auth.json 读取认证信息 */
function readAuthKey(authKeyName: string): string | null {
  try {
    const home = process.env.HOME || process.env.USERPROFILE || "";
    const authPath = join(home, ".pi", "agent", "auth.json");
    const raw = readFileSync(authPath, "utf-8");
    const auth = JSON.parse(raw);
    const entry = auth[authKeyName];
    if (!entry) return null;
    if (entry.type === "api_key" && entry.key) return entry.key;
    if (typeof entry === "string") return entry;
    if (entry.key) return entry.key;
    return null;
  } catch {
    return null;
  }
}

/** 从 auth.json 读取 OAuth access token */
function readOAuthAccessToken(authKeyName: string): string | null {
  try {
    const home = process.env.HOME || process.env.USERPROFILE || "";
    const authPath = join(home, ".pi", "agent", "auth.json");
    const raw = readFileSync(authPath, "utf-8");
    const auth = JSON.parse(raw);
    const entry = auth[authKeyName];
    if (!entry) return null;
    if (entry.type === "oauth" && entry.access) {
      // 检查是否过期
      if (entry.expires && entry.expires < Date.now()) {
        return null; // token 已过期
      }
      return entry.access;
    }
    return null;
  } catch {
    return null;
  }
}

/** 检查 GitHub CLI 是否已安装并登录 */
function checkGitHubCLI(): boolean {
  try {
    const result = execSync("gh auth status", {
      encoding: "utf-8",
      timeout: 5_000,
    });
    return result.includes("Logged in");
  } catch {
    return false;
  }
}

/** 格式化余额数据为显示行 */
function formatBalances(result: QuotaResult): string[] {
  const lines: string[] = [];

  if (result.error) {
    lines.push(`  ❌ ${result.error}`);
    return lines;
  }

  if (!result.available) {
    lines.push(`  ⚠️  账户不可用`);
    return lines;
  }

  for (const b of result.balances) {
    if (b.currency === "Plan") {
      lines.push(`  📋 ${b.totalBalance}`);
    } else if (b.currency === "Premium Requests") {
      lines.push(`  🤖 Premium Requests: ${b.totalBalance}`);
      if (b.resetDate) {
        lines.push(`     📅 重置日期: ${b.resetDate}`);
      }
      if (b.planName) {
        lines.push(`     📋 套餐: ${b.planName}`);
      }
    } else if (b.currency === "Extra Usage") {
      lines.push(`  💰 Extra Usage: ${b.totalBalance}`);
    } else if (
      b.currency.startsWith("5h ") ||
      b.currency.startsWith("7d ")
    ) {
      lines.push(`  📊 ${b.currency}: ${b.totalBalance}`);
    } else if (/limit/i.test(b.currency)) {
      lines.push(`  📊 ${b.currency}: ${b.totalBalance}`);
    } else {
      lines.push(`  💬 ${b.currency}: ${b.totalBalance}`);
    }
  }

  return lines;
}

// ===================================================================
//  Extension 入口
// ===================================================================

export default function (pi: ExtensionAPI) {
  pi.registerCommand("quota", {
    description: "查询 AI 提供商账户余额/配额（支持: anthropic, deepseek, github-copilot, kimi-coding, zai-coding-cn）",
    handler: async (_args, ctx) => {
      const allLines: string[] = [];
      let anyProvider = false;

      for (const provider of PROVIDERS) {
        let apiKey: string | null = null;
        let skipReason: string | null = null;

        if (provider.authType === "api_key") {
          apiKey = readAuthKey(provider.authKey);
          if (!apiKey) {
            skipReason = `auth.json 中未配置 "${provider.authKey}"`;
          }
        } else if (provider.authType === "oauth") {
          apiKey = readOAuthAccessToken(provider.authKey);
          if (!apiKey) {
            skipReason = `auth.json 中未配置 OAuth "${provider.authKey}"，请先运行 /login`;
          }
        } else if (provider.authType === "cli") {
          if (!checkGitHubCLI()) {
            skipReason = "gh CLI 未安装或未登录，请运行 `gh auth login`";
          }
        }

        if (skipReason) {
          continue;
        }

        anyProvider = true;

        try {
          const result = await provider.fetcher(apiKey ?? "");
          allLines.push(`📋 ${result.label}`);
          allLines.push(...formatBalances(result));
        } catch (err) {
          allLines.push(`📋 ${provider.label}`);
          allLines.push(`  ❌ 查询失败: ${err instanceof Error ? err.message : String(err)}`);
        }
        allLines.push("");
      }

      if (!anyProvider) {
        allLines.push("⚠️ 当前没有已配置的 Provider，请先运行 /login 或配置 auth.json。");
      }

      allLines.push("---");
      allLines.push("💡 需要查询其他 Provider 的余额/配额？");
      allLines.push("   编辑 ~/.pi/agent/extensions/quota.ts 中 PROVIDERS 数组即可添加。");

      ctx.ui.notify(allLines.join("\n"), "info");
    },
  });
}
