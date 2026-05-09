/**
 * /quota 命令 - 查询各 AI 提供商的账户余额/配额
 *
 * 支持的 Provider:
 *   - deepseek       ✅ 余额查询（人民币）
 *   - github-copilot ✅ 配额查询（Premium Requests / 月）
 *   - openai         🔲 待实现
 *   - google         🔲 待实现
 *   - anthropic      🔲 待实现（无官方余额 API）
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
  authType: "api_key" | "cli" | "oauth";
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
//  Provider 注册表
// ===================================================================
//
// 添加新的 Provider：在此数组中增加一项即可。
// authType 说明：
//   "api_key" - 从 auth.json 读取 API key
//   "cli"     - 通过命令行工具获取认证（如 gh）
//   "oauth"   - 从 auth.json 读取 OAuth token（预留）

const PROVIDERS: ProviderConfig[] = [
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
  // ──── 预留 Provider 占位 ────
  // 要添加新的 Provider，只需在此数组中增加一项即可。
  //
  // {
  //   key: "openai",
  //   label: "OpenAI",
  //   authKey: "openai",
  //   authType: "api_key",
  //   fetcher: async (apiKey) => {
  //     // 实现 OpenAI 额度查询逻辑
  //     // 参考: https://platform.openai.com/docs/api-reference/credit-grants
  //     const res = await fetch("https://api.openai.com/v1/dashboard/billing/credit_grants", {
  //       headers: { Authorization: `Bearer ${apiKey}` },
  //     });
  //     ...
  //   },
  // },
  //
  // {
  //   key: "google",
  //   label: "Google Gemini",
  //   authKey: "google",
  //   authType: "api_key",
  //   fetcher: async (apiKey) => {
  //     // Google Gemini 目前是免费额度，可通过 API 查询使用量
  //   },
  // },
];

// ===================================================================
//  工具函数
// ===================================================================

/** 从 auth.json 读取 API key */
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
    if (b.currency === "Premium Requests") {
      lines.push(`  🤖 Premium Requests: ${b.totalBalance}`);
      if (b.resetDate) {
        lines.push(`     📅 重置日期: ${b.resetDate}`);
      }
      if (b.planName) {
        lines.push(`     📋 套餐: ${b.planName}`);
      }
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
    description: "查询 AI 提供商账户余额/配额（支持: deepseek, github-copilot）",
    handler: async (_args, ctx) => {
      const allLines: string[] = [];

      for (const provider of PROVIDERS) {
        let apiKey: string | null = null;
        let skipReason: string | null = null;

        if (provider.authType === "api_key" || provider.authType === "oauth") {
          apiKey = readAuthKey(provider.authKey);
          if (!apiKey) {
            skipReason = `auth.json 中未配置 "${provider.authKey}"`;
          }
        } else if (provider.authType === "cli") {
          if (!checkGitHubCLI()) {
            skipReason = "gh CLI 未安装或未登录，请运行 `gh auth login`";
          }
        }

        if (skipReason) {
          allLines.push(`📋 ${provider.label}`);
          allLines.push(`   ⏭️  ${skipReason}`);
          allLines.push("");
          continue;
        }

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

      allLines.push("---");
      allLines.push("💡 需要查询其他 Provider 的余额/配额？");
      allLines.push("   编辑 ~/.pi/agent/extensions/quota.ts 中 PROVIDERS 数组即可添加。");

      ctx.ui.notify(allLines.join("\n"), "info");
    },
  });
}
