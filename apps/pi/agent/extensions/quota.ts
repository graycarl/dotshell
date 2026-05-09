/**
 * /quota 命令 - 查询各 AI 提供商的账户余额
 *
 * 支持的 Provider:
 *   - deepseek  ✅ 已实现
 *   - openai    🔲 待实现
 *   - google    🔲 待实现
 *   - anthropic 🔲 待实现
 *   - ...       🔲 待实现
 *
 * 安装位置: ~/.pi/agent/extensions/quota.ts
 * 使用 /reload 或重启 pi 后生效
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ──────────────────────────────────────────────
// 类型定义（预留扩展接口）
// ──────────────────────────────────────────────

/** 单个 Provider 的余额信息 */
interface QuotaResult {
  /** 提供商名称 */
  provider: string;
  /** 显示用标签 */
  label: string;
  /** 是否查询成功 */
  available: boolean;
  /** 余额列表（不同币种/类型） */
  balances: BalanceItem[];
  /** 错误信息（如果查询失败） */
  error?: string;
}

interface BalanceItem {
  currency: string;
  totalBalance: string;
  grantedBalance?: string;
  toppedUpBalance?: string;
}

/** Provider 查询函数签名 */
type QuotaFetcher = (apiKey: string) => Promise<QuotaResult>;

/** Provider 注册信息 */
interface ProviderConfig {
  key: string;
  label: string;
  authKey: string; // auth.json 中的 key
  fetcher: QuotaFetcher;
}

// ──────────────────────────────────────────────
// DeepSeek 余额查询
// ──────────────────────────────────────────────

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

// ──────────────────────────────────────────────
// Provider 注册表
// ──────────────────────────────────────────────
//
// 预留其他 Provider 的插槽。后续只需在此补充：
//
//   {
//     key: "openai",
//     label: "OpenAI",
//     authKey: "openai",
//     fetcher: fetchOpenAICredit,  // 待实现
//   },
//
// 注意：anthropic 目前没有官方余额查询 API，需要特殊处理。其他
// 平台可参考各自的开发者文档实现。

const PROVIDERS: ProviderConfig[] = [
  {
    key: "deepseek",
    label: "DeepSeek",
    authKey: "deepseek",
    fetcher: fetchDeepSeekQuota,
  },
  // ──── 预留 Provider 占位 ────
  // 要添加新的 Provider，只需在此数组中增加一项：
  //
  // {
  //   key: "openai",
  //   label: "OpenAI",
  //   authKey: "openai",
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
  //   fetcher: async (apiKey) => {
  //     // 实现 Google Gemini 额度查询逻辑
  //   },
  // },
];

// ──────────────────────────────────────────────
// 工具函数
// ──────────────────────────────────────────────

/** 从 auth.json 读取 API key */
function readAuthKey(authKeyName: string): string | null {
  try {
    const home = process.env.HOME || process.env.USERPROFILE || "";
    const authPath = join(home, ".pi", "agent", "auth.json");
    const raw = readFileSync(authPath, "utf-8");
    const auth = JSON.parse(raw);
    const entry = auth[authKeyName];
    if (!entry) return null;
    // auth.json 格式：{ "deepseek": { "type": "api_key", "key": "sk-..." } }
    if (entry.type === "api_key" && entry.key) return entry.key;
    if (typeof entry === "string") return entry;
    if (entry.key) return entry.key;
    return null;
  } catch {
    return null;
  }
}

/** 格式化余额数据为显示行 */
function formatBalances(provider: QuotaResult): string[] {
  const lines: string[] = [];

  if (provider.error) {
    lines.push(`  ❌ 查询失败: ${provider.error}`);
    return lines;
  }

  if (!provider.available) {
    lines.push(`  ⚠️  账户不可用`);
    return lines;
  }

  for (const b of provider.balances) {
    const currencySymbol =
      b.currency === "CNY" ? "¥" : b.currency === "USD" ? "$" : `${b.currency} `;
    lines.push(`  💰 余额: ${currencySymbol}${b.totalBalance}`);
    if (b.grantedBalance !== undefined && b.grantedBalance !== "0.00") {
      lines.push(`     🎁 赠送: ${currencySymbol}${b.grantedBalance}`);
    }
    if (b.toppedUpBalance !== undefined && b.toppedUpBalance !== "0.00") {
      lines.push(`     💳 充值: ${currencySymbol}${b.toppedUpBalance}`);
    }
  }

  return lines;
}

// ──────────────────────────────────────────────
// Extension 入口
// ──────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  pi.registerCommand("quota", {
    description: "查询 AI 提供商账户余额（当前支持: deepseek）",
    handler: async (_args, ctx) => {
      const results: string[] = [];
      let hasAnyProvider = false;

      for (const provider of PROVIDERS) {
        const apiKey = readAuthKey(provider.authKey);

        if (!apiKey) {
          results.push(`📋 ${provider.label}`);
          results.push(`   ⏭️  未配置 API key（auth.json 中缺少 "${provider.authKey}"）`);
          results.push("");
          continue;
        }

        hasAnyProvider = true;

        try {
          const result = await provider.fetcher(apiKey);
          results.push(`📋 ${result.label}`);
          results.push(...formatBalances(result));
        } catch (err) {
          results.push(`📋 ${provider.label}`);
          results.push(`  ❌ 查询异常: ${err instanceof Error ? err.message : String(err)}`);
        }
        results.push("");
      }

      // 末尾提示预留信息
      results.push("---");
      results.push("💡 需要查询其他 Provider 的余额？");
      results.push("   编辑 ~/.pi/agent/extensions/quota.ts 中 PROVIDERS 数组即可添加。");

      ctx.ui.notify(results.join("\n"), "info");
    },
  });
}
