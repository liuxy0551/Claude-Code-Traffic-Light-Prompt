import { useState, useEffect, useRef, useCallback } from "react";

type Light = "red" | "yellow" | "green";
type Theme = "dark" | "light";
type Style = "single" | "triple-vertical" | "triple-horizontal";
type UsageMode = "mimo" | "chatgpt" | "agy" | "none";

interface UsageSlots {
  top: UsageMode;
  bottom: UsageMode;
}

interface BalanceItem {
  isValid: boolean;
  planName?: string;
  used?: number;
  total?: number;
  remaining?: number;
  unit?: string;
  extra?: string;
}

interface BalanceData {
  isValid?: boolean;
  used?: number;
  total?: number;
  remaining?: number;
  unit?: string;
  extra?: string;
  error?: string;
  items?: BalanceItem[];
}

interface ChatGPTWindowData {
  usedPercent: number;
  windowSeconds: number;
  resetAfterSeconds: number;
  resetAt: number;
}

interface ChatGPTUsageData {
  isValid?: boolean;
  error?: string;
  primary?: ChatGPTWindowData | null;
  secondary?: ChatGPTWindowData | null;
}

interface AgyBucketData {
  remainingFraction: number;
  remainingPercent: number;
  displayPercent: string;
  roundedPercent: number;
  resetTime?: string | null;
  resetInSeconds?: number;
  resetText?: string;
}

interface AgyGroupData {
  displayName: string;
  description: string;
  weekly?: AgyBucketData | null;
  fiveHour?: AgyBucketData | null;
}

interface AgyUsageData {
  isValid: boolean;
  error?: string;
  email?: string;
  planTier?: string;
  activeModel?: string;
  activeGroup?: "gemini" | "3p";
  activeFiveHour?: AgyBucketData | null;
  activeWeekly?: AgyBucketData | null;
  gemini?: AgyGroupData | null;
  threeP?: AgyGroupData | null;
  updatedAt?: number;
}

declare global {
  interface Window {
    electronAPI: {
      onStateChange: (cb: (state: string) => void) => () => void;
      onThemeChange: (cb: (theme: string) => void) => () => void;
      onStyleChange: (cb: (style: string) => void) => () => void;
      setState: (state: string) => void;
      quit: () => void;
      getTheme: () => Promise<string>;
      setTheme: (theme: string) => void;
      getStyle: () => Promise<string>;
      setStyle: (style: string) => void;
      focusApp: () => void;
      getMute: () => Promise<boolean>;
      setMute: (muted: boolean) => void;
      setWindowHeight: (h: number) => void;
      fetchBalance: () => Promise<BalanceData>;
      openBalanceTooltip: (data: BalanceData) => void;
      onBalanceUpdate: (cb: (data: BalanceData) => void) => () => void;
      onBalanceVisibleChange: (cb: (visible: boolean) => void) => () => void;
      // ChatGPT
      fetchChatGPTUsage: () => Promise<ChatGPTUsageData>;
      openChatGPTTooltip: (data: ChatGPTUsageData) => void;
      onChatGPTUpdate: (cb: (data: ChatGPTUsageData) => void) => () => void;
      updateChatGPTToken: (token: string) => Promise<{ ok: boolean; error?: string }>;
      onMuteChange: (cb: (muted: boolean) => void) => () => void;
      onOpenChatGPTTooltipFromTray: (cb: (data: ChatGPTUsageData) => void) => () => void;
      onOpenBalanceTooltipFromTray: (cb: (data: BalanceData) => void) => () => void;
      // Antigravity (agy)
      fetchAgyUsage: () => Promise<AgyUsageData>;
      openAgyTooltip: (data: AgyUsageData) => void;
      onAgyUpdate: (cb: (data: AgyUsageData) => void) => () => void;
      onOpenAgyTooltipFromTray?: (cb: (data: AgyUsageData) => void) => () => void;
      getUsageMode: () => Promise<UsageMode>;
      onUsageModeChange: (cb: (mode: UsageMode) => void) => () => void;
      // 双槽位用量模式
      getUsageSlots?: () => Promise<UsageSlots>;
      setUsageSlots?: (slots: UsageSlots) => Promise<{ ok: boolean }>;
      onUsageSlotsChange?: (cb: (slots: UsageSlots) => void) => () => void;
    };
  }
}

const LIGHT_CONFIG = {
  red:    { active: "#FF3B30", dimDark: "#2a1110", dimLight: "#fde8e7", glow: "rgba(255,59,48,0.55)",  innerGlow: "rgba(255,100,80,0.3)"  },
  yellow: { active: "#FF9F0A", dimDark: "#271d08", dimLight: "#fef3dc", glow: "rgba(255,159,10,0.55)", innerGlow: "rgba(255,180,60,0.3)"  },
  green:  { active: "#30D158", dimDark: "#0b2818", dimLight: "#d8f5e4", glow: "rgba(48,209,88,0.55)",  innerGlow: "rgba(80,220,110,0.3)"  },
};

const ORDER: Light[] = ["red", "yellow", "green"];

export default function App() {
  const [active, setActive]           = useState<Light>("green");
  const [theme, setThemeState]        = useState<Theme>("dark");
  const [style, setStyleState]        = useState<Style>("triple-vertical");
  const [greenSteady, setGreenSteady] = useState(false);
  const [muted, setMuted]             = useState(false);
  const [balance, setBalance]         = useState<BalanceData | null>(null);
  const [balanceVisible, setBalanceVisible] = useState(true);
  const [chatgptUsage, setChatgptUsage] = useState<ChatGPTUsageData | null>(null);
  const [agyUsage, setAgyUsage]       = useState<AgyUsageData | null>(null);
  const [usageSlots, setUsageSlots]   = useState<UsageSlots>({ top: "chatgpt", bottom: "agy" });
  const greenTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const audioCtxRef   = useRef<AudioContext | null>(null);

  useEffect(() => {
    if (!window.electronAPI) return;
    window.electronAPI.getTheme().then((t) => {
      if (t === "light" || t === "dark") setThemeState(t as Theme);
    });
    window.electronAPI.getMute().then((m) => setMuted(m));
    window.electronAPI.getStyle().then((s) => {
      if (s === "single" || s === "triple-vertical" || s === "triple-horizontal") setStyleState(s as Style);
    });
    // 初始状态为绿色时，2.5秒后停止闪烁
    greenTimerRef.current = setTimeout(() => setGreenSteady(true), 2500);
  }, []);

  useEffect(() => {
    if (!window.electronAPI) return;
    return window.electronAPI.onThemeChange((t) => {
      if (t === "light" || t === "dark") setThemeState(t as Theme);
    });
  }, []);

  useEffect(() => {
    if (!window.electronAPI) return;
    return window.electronAPI.onStyleChange((s) => {
      if (s === "single" || s === "triple-vertical" || s === "triple-horizontal") setStyleState(s as Style);
    });
  }, []);

  // 余量查询：启动时获取，监听自动刷新，监听显隐
  useEffect(() => {
    if (!window.electronAPI?.fetchBalance) return;
    window.electronAPI.fetchBalance().then((d) => setBalance(d));
    const off1 = window.electronAPI.onBalanceUpdate((d) => setBalance(d));
    const off2 = window.electronAPI.onBalanceVisibleChange((v) => setBalanceVisible(v));
    return () => { off1(); off2(); };
  }, []);

  // 用量显示模式（支持双槽位同时展示）：启动时获取，监听变化
  useEffect(() => {
    if (window.electronAPI?.getUsageSlots) {
      window.electronAPI.getUsageSlots().then((slots) => {
        if (slots) setUsageSlots(slots);
      });
      const offSlots = window.electronAPI.onUsageSlotsChange?.((slots) => {
        if (slots) setUsageSlots(slots);
      });
      return () => { offSlots?.(); };
    }
    if (window.electronAPI?.getUsageMode) {
      window.electronAPI.getUsageMode().then((m) => {
        if (m) setUsageSlots({ top: "none", bottom: m });
      });
      const offMode = window.electronAPI.onUsageModeChange((m) => {
        if (m) setUsageSlots((prev) => ({ ...prev, bottom: m }));
      });
      return () => { offMode(); };
    }
  }, []);

  // ChatGPT 用量查询：启动时获取，监听自动刷新
  useEffect(() => {
    if (!window.electronAPI?.fetchChatGPTUsage) return;
    window.electronAPI.fetchChatGPTUsage().then((d) => setChatgptUsage(d));
    const off1 = window.electronAPI.onChatGPTUpdate((d) => setChatgptUsage(d));
    // 从托盘菜单打开 ChatGPT tooltip
    const off2 = window.electronAPI.onOpenChatGPTTooltipFromTray((d) => {
      setChatgptUsage(d);
      window.electronAPI?.openChatGPTTooltip(d);
    });
    // 从托盘菜单打开 MiMo tooltip
    const off3 = window.electronAPI.onOpenBalanceTooltipFromTray((d) => {
      setBalance(d);
      window.electronAPI?.openBalanceTooltip(d);
    });
    return () => { off1(); off2(); off3(); };
  }, []);

  // Antigravity (agy) 用量查询：启动时获取，监听自动刷新
  useEffect(() => {
    if (!window.electronAPI?.fetchAgyUsage) return;
    window.electronAPI.fetchAgyUsage().then((d) => setAgyUsage(d));
    const off1 = window.electronAPI.onAgyUpdate((d) => setAgyUsage(d));
    const off2 = window.electronAPI.onOpenAgyTooltipFromTray?.((d) => {
      setAgyUsage(d);
      window.electronAPI?.openAgyTooltip(d);
    });
    return () => {
      off1();
      off2?.();
    };
  }, []);

  // 监听托盘菜单的静音切换
  useEffect(() => {
    if (!window.electronAPI?.onMuteChange) return;
    return window.electronAPI.onMuteChange((m) => setMuted(m));
  }, []);

  // 用 Web Audio API 合成轻提示音，无需音频文件
  const playSound = useCallback((light: Light) => {
    if (muted) return;
    try {
      if (!audioCtxRef.current) audioCtxRef.current = new AudioContext();
      const ctx = audioCtxRef.current;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);

      // 红=低沉短促，黄=中音，绿=清脆双音
      if (light === "red") {
        osc.type = "sine";
        osc.frequency.setValueAtTime(320, ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(220, ctx.currentTime + 0.12);
        gain.gain.setValueAtTime(0.18, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.18);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.18);
      } else if (light === "yellow") {
        osc.type = "sine";
        osc.frequency.setValueAtTime(480, ctx.currentTime);
        gain.gain.setValueAtTime(0.12, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.15);
      } else {
        // 绿灯：两个音符，清脆上扬
        const osc2 = ctx.createOscillator();
        const gain2 = ctx.createGain();
        osc2.connect(gain2);
        gain2.connect(ctx.destination);

        osc.type = "sine";
        osc.frequency.setValueAtTime(660, ctx.currentTime);
        gain.gain.setValueAtTime(0.15, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.12);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.12);

        osc2.type = "sine";
        osc2.frequency.setValueAtTime(880, ctx.currentTime + 0.1);
        gain2.gain.setValueAtTime(0.0, ctx.currentTime);
        gain2.gain.setValueAtTime(0.15, ctx.currentTime + 0.1);
        gain2.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.28);
        osc2.start(ctx.currentTime + 0.1);
        osc2.stop(ctx.currentTime + 0.28);
      }
    } catch {}
  }, [muted]);

  // 红=缓慢呼吸，黄=闪烁，绿=闪烁 2.5s 后常亮
  const applyState = useCallback((state: string) => {
    const s = state as Light;
    if (!ORDER.includes(s)) return;
    if (greenTimerRef.current) { clearTimeout(greenTimerRef.current); greenTimerRef.current = null; }
    setGreenSteady(false);
    setActive(s);
    playSound(s);
    if (s === "green") {
      greenTimerRef.current = setTimeout(() => setGreenSteady(true), 2500);
    }
  }, [playSound]);

  useEffect(() => {
    if (!window.electronAPI) return;
    const cleanup = window.electronAPI.onStateChange(applyState);
    return () => {
      cleanup();
      if (greenTimerRef.current) clearTimeout(greenTimerRef.current);
    };
  }, [applyState]);

  const handleManualSelect = (light: Light) => {
    applyState(light);
    window.electronAPI?.setState(light);
  };

  const dark = theme === "dark";

  useEffect(() => {
    if (!window.electronAPI) return;
    let height, width;
    if (style === "single") {
      height = 110; width = 100;
    } else if (style === "triple-horizontal") {
      height = 130; width = 220;
    } else {
      height = 220; width = 100;
    }
    window.electronAPI.setWindowHeight(height);
    // 横版需要更宽的窗口
    if (style === "triple-horizontal") {
      window.electronAPI.setWindowWidth(width);
    } else {
      window.electronAPI.setWindowWidth(100);
    }
  }, [style]);

  const housing = dark
    ? {
        background: "linear-gradient(180deg, #3a3a3c 0%, #2c2c2e 40%, #232325 100%)",
        boxShadow: "0 2px 0px rgba(255,255,255,0.06) inset, 0 -1px 0px rgba(0,0,0,0.5) inset",
        border: "1px solid rgba(255,255,255,0.07)",
      }
    : {
        background: "linear-gradient(180deg, #ffffff 0%, #f5f5f7 100%)",
        boxShadow: "0 1px 0px rgba(255,255,255,0.9) inset, 0 -1px 0px rgba(0,0,0,0.06) inset",
        border: "1px solid rgba(0,0,0,0.08)",
      };

  // 上方是否有用量显示（用于自适应调整外壳上下内边距）
  const hasTopUsage = Boolean(usageSlots.top && usageSlots.top !== "none");
  const containerPadding = style === "single"
    ? (hasTopUsage ? "22px 0 16px" : "16px 0 16px")
    : style === "triple-horizontal"
      ? (hasTopUsage ? "22px 14px 22px" : "16px 14px 20px")
      : (hasTopUsage ? "22px 0 22px" : "16px 0 20px");

  // 渲染指定槽位（上方 top 或下方 bottom）的用量角标
  const renderUsageSlot = (slot: "top" | "bottom") => {
    const mode = usageSlots[slot];
    if (!mode || mode === "none") return null;

    const isTop = slot === "top";
    const posStyle = (side: "left" | "right") => ({
      position: "absolute" as const,
      [isTop ? "top" : "bottom"]: 2,
      [side]: 4,
      minWidth: 28,
      height: 20,
      borderRadius: 8,
      border: "none",
      padding: "0 3px",
      fontSize: 10,
      fontWeight: 600,
      cursor: "pointer",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      WebkitAppRegion: "no-drag" as const,
      fontVariantNumeric: "tabular-nums" as const,
    });

    if (mode === "mimo") {
      if (!balanceVisible) return null;
      // 统一转为余量百分比展示
      const balancePercent = (() => {
        if (!balance) return null;
        const target = balance.items?.length ? balance.items[0] : balance;
        if (!target || !target.isValid) return null;
        if (typeof target.remaining === "number" && typeof target.total === "number" && target.total > 0) {
          return Math.round((target.remaining / target.total) * 100);
        }
        if (target.extra) {
          const usedPct = parseFloat(target.extra);
          return isNaN(usedPct) ? null : Math.max(0, Math.min(100, Math.round(100 - usedPct)));
        }
        return null;
      })();

      // 余量配色统一：充足(>50%)绿，适中(>=20%)橙，紧张(<20%)红
      const color = balancePercent === null
        ? (dark ? "rgba(255,255,255,0.4)" : "rgba(0,0,0,0.3)")
        : balancePercent > 50
          ? "#30D158"
          : balancePercent >= 20
            ? "#FF9F0A"
            : "#FF3B30";

      const bg = balancePercent === null
        ? "rgba(255,255,255,0.08)"
        : balancePercent > 50
          ? "rgba(48,209,88,0.15)"
          : balancePercent >= 20
            ? "rgba(255,159,10,0.15)"
            : "rgba(255,59,48,0.15)";

      return (
        <button
          key={`${slot}-mimo`}
          className="no-drag"
          onClick={() => window.electronAPI?.openBalanceTooltip(balance || {})}
          style={{
            ...posStyle("left"),
            background: bg,
            color,
          }}
        >
          {balancePercent !== null ? balancePercent + "%" : "0%"}
        </button>
      );
    }

    if (mode === "chatgpt") {
      const p = chatgptUsage?.primary;
      const isPrimaryWeekly = p && p.windowSeconds >= 86400;
      // 统一计算为余量百分比（100 - usedPercent）
      const primaryRemaining = chatgptUsage?.isValid && p ? Math.max(0, Math.min(100, 100 - p.usedPercent)) : 0;

      const weekly = chatgptUsage?.secondary
        || (chatgptUsage?.primary && chatgptUsage.primary.windowSeconds >= 86400 ? chatgptUsage.primary : null);
      // 统一计算为余量百分比（100 - usedPercent）
      const weeklyRemaining = chatgptUsage?.isValid && weekly ? Math.max(0, Math.min(100, 100 - weekly.usedPercent)) : 0;

      // 余量配色统一：充足(>50%)绿，适中(>=20%)橙，紧张(<20%)红
      const getCodexColor = (pct: number) => {
        if (!chatgptUsage?.isValid) return dark ? "rgba(255,255,255,0.4)" : "rgba(0,0,0,0.3)";
        return pct > 50 ? "#30D158" : pct >= 20 ? "#FF9F0A" : "#FF3B30";
      };

      const getCodexBg = (pct: number) => {
        if (!chatgptUsage?.isValid) return "rgba(255,255,255,0.08)";
        return pct > 50 ? "rgba(48,209,88,0.15)" : pct >= 20 ? "rgba(255,159,10,0.15)" : "rgba(255,59,48,0.15)";
      };

      return (
        <div key={`${slot}-chatgpt-group`}>
          {!isPrimaryWeekly && (
            <button
              key={`${slot}-chatgpt-primary`}
              className="no-drag"
              onClick={() => window.electronAPI?.openChatGPTTooltip(chatgptUsage || { isValid: false, error: "未查询" })}
              style={{
                ...posStyle("left"),
                background: getCodexBg(primaryRemaining),
                color: getCodexColor(primaryRemaining),
              }}
            >
              {primaryRemaining}%
            </button>
          )}
          <button
            key={`${slot}-chatgpt-weekly`}
            className="no-drag"
            onClick={() => window.electronAPI?.openChatGPTTooltip(chatgptUsage || { isValid: false, error: "未查询" })}
            style={{
              ...posStyle("right"),
              background: getCodexBg(weeklyRemaining),
              color: getCodexColor(weeklyRemaining),
            }}
          >
            {weeklyRemaining}%
          </button>
        </div>
      );
    }

    if (mode === "agy") {
      const fiveHour = agyUsage?.activeFiveHour;
      const fivePct = agyUsage?.isValid && fiveHour ? fiveHour.roundedPercent : 0;

      const weekly = agyUsage?.activeWeekly;
      const weeklyPct = agyUsage?.isValid && weekly ? weekly.roundedPercent : 0;

      const getAgyColor = (pct: number) => {
        if (!agyUsage?.isValid) return dark ? "rgba(255,255,255,0.4)" : "rgba(0,0,0,0.3)";
        return pct > 50 ? "#30D158" : pct >= 20 ? "#FF9F0A" : "#FF3B30";
      };

      const getAgyBg = (pct: number) => {
        if (!agyUsage?.isValid) return "rgba(255,255,255,0.08)";
        return pct > 50 ? "rgba(48,209,88,0.15)" : pct >= 20 ? "rgba(255,159,10,0.15)" : "rgba(255,59,48,0.15)";
      };

      return (
        <div key={`${slot}-agy-group`}>
          <button
            key={`${slot}-agy-5h`}
            className="no-drag"
            onClick={() => window.electronAPI?.openAgyTooltip(agyUsage || { isValid: false, error: "未获取到数据" })}
            style={{
              ...posStyle("left"),
              background: getAgyBg(fivePct),
              color: getAgyColor(fivePct),
            }}
          >
            {agyUsage?.isValid && fiveHour ? `${fivePct}%` : "0%"}
          </button>
          <button
            key={`${slot}-agy-weekly`}
            className="no-drag"
            onClick={() => window.electronAPI?.openAgyTooltip(agyUsage || { isValid: false, error: "未获取到数据" })}
            style={{
              ...posStyle("right"),
              background: getAgyBg(weeklyPct),
              color: getAgyColor(weeklyPct),
            }}
          >
            {agyUsage?.isValid && weekly ? `${weeklyPct}%` : "0%"}
          </button>
        </div>
      );
    }

    return null;
  };

  return (
    <div
      className="size-full flex flex-col items-center justify-start pt-3"
      onMouseDown={() => window.electronAPI?.focusApp()}
      style={{
        fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
        background: "transparent",
        WebkitAppRegion: "drag",
      } as React.CSSProperties}
    >
      <style>{`
        @keyframes breathe-red {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.35; }
        }
        @keyframes pulse-glow {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.2; transform: scale(0.93); }
        }
        @keyframes ring-pulse {
          0% { box-shadow: 0 0 0 0px var(--ring-color); opacity: 1; }
          100% { box-shadow: 0 0 0 20px transparent; opacity: 0; }
        }
        .light-breathe-red { animation: breathe-red 2s ease-in-out infinite; }
        .light-active { animation: pulse-glow 0.55s ease-in-out infinite; }
        .ring-pulse-yellow { --ring-color: rgba(255,159,10,0.6); animation: ring-pulse 0.55s ease-out infinite; }
        .ring-pulse-green  { --ring-color: rgba(48,209,88,0.6);  animation: ring-pulse 0.55s ease-out infinite; }
        .no-drag { -webkit-app-region: no-drag; }
      `}</style>

      {/* 外壳容器：可拖拽，灯泡单独设为 no-drag */}
      <div
        className="relative flex flex-col items-center"
        style={{ ...housing, borderRadius: 20, width: style === "triple-horizontal" ? 200 : 80, padding: containerPadding, WebkitAppRegion: "drag" } as React.CSSProperties}
      >
        {style === "single" ? (
          /* 单灯模式：一个灯显示当前状态颜色 */
          <div className="flex flex-col items-center">
            {(() => {
              const cfg = LIGHT_CONFIG[active];
              const isBlinking = active === "yellow" || (active === "green" && !greenSteady);
              const isBreathing = active === "red";
              const dim = dark ? cfg.dimDark : cfg.dimLight;
              return (
                <div className="relative flex items-center justify-center">
                  {isBlinking && (
                    <div
                      className={`ring-pulse-${active}`}
                      style={{ position: "absolute", width: 44, height: 44, borderRadius: "50%", pointerEvents: "none" }}
                    />
                  )}
                  {!dark && active === "red" && (
                    <img src="dog.gif" alt="" style={{ position: "absolute", width: 48, height: 48, objectFit: "contain", mixBlendMode: "screen", pointerEvents: "none", zIndex: 10 }} />
                  )}
                  {!dark && active === "green" && (
                    <img src="dog-green.gif" alt="" style={{ position: "absolute", width: 48, height: 48, objectFit: "contain", mixBlendMode: "multiply", pointerEvents: "none", zIndex: 10 }} />
                  )}
                  <div
                    style={{
                      width: 44, height: 44, borderRadius: "50%",
                      background: dim,
                      boxShadow: dark
                        ? `inset 0 2px 8px rgba(0,0,0,0.6), 0 0 20px ${cfg.glow}, 0 0 40px ${cfg.glow}`
                        : `inset 0 2px 8px rgba(0,0,0,0.08), 0 0 10px ${cfg.glow}`,
                      border: `1px solid ${cfg.active}30`,
                      display: "flex", alignItems: "center", justifyContent: "center",
                      cursor: "pointer", transition: "all 0.3s ease",
                    }}
                    onClick={() => {
                      const next: Light = active === "red" ? "yellow" : active === "yellow" ? "green" : "red";
                      handleManualSelect(next);
                    }}
                  >
                    <div
                      className={isBreathing ? "light-breathe-red" : isBlinking ? "light-active" : ""}
                      style={{
                        width: 34, height: 34, borderRadius: "50%",
                        background: `radial-gradient(circle at 38% 36%, ${cfg.active}ff 0%, ${cfg.active}dd 40%, ${cfg.active}88 100%)`,
                        boxShadow: dark
                          ? `0 0 12px ${cfg.glow}, 0 0 4px ${cfg.innerGlow}, inset 0 1px 2px rgba(255,255,255,0.25)`
                          : `0 0 6px ${cfg.glow}, inset 0 1px 2px rgba(255,255,255,0.4)`,
                        transition: "all 0.4s ease",
                        display: "flex", alignItems: "center", justifyContent: "center",
                      }}
                    >
                      {active !== "red" ? (
                        <div style={{ width: 16, height: 10, borderRadius: "50%", background: "rgba(255,255,255,0.35)", marginTop: 10, filter: "blur(2px)" }} />
                      ) : null}
                    </div>
                  </div>
                </div>
              );
            })()}
          </div>
        ) : (
          /* 三灯模式 */
          <div className={style === "triple-horizontal" ? "flex flex-row items-center gap-3" : "flex flex-col items-center gap-3"}>
          {ORDER.map((light) => {
            const cfg = LIGHT_CONFIG[light];
            const isActive = active === light;
            const dim = dark ? cfg.dimDark : cfg.dimLight;
            const isBlinking = isActive && (light === "yellow" || (light === "green" && !greenSteady));
            const isBreathing = isActive && light === "red";

            return (
              <div key={light} className="relative flex items-center justify-center">
                {isBlinking && (
                  <div
                    className={`ring-pulse-${light}`}
                    style={{ position: "absolute", width: 44, height: 44, borderRadius: "50%", pointerEvents: "none" }}
                  />
                )}
                {/* 浅色主题红灯时，小狗叠在灯上 */}
                {!dark && light === "red" && active === "red" && (
                  <img
                    src="dog.gif"
                    alt=""
                    style={{
                      position: "absolute",
                      width: 48, height: 48,
                      objectFit: "contain",
                      mixBlendMode: "screen",
                      pointerEvents: "none",
                      zIndex: 10,
                    }}
                  />
                )}
                {/* 浅色主题绿灯时，小狗叠在灯上 */}
                {!dark && light === "green" && active === "green" && (
                  <img
                    src="dog-green.gif"
                    alt=""
                    style={{
                      position: "absolute",
                      width: 48, height: 48,
                      objectFit: "contain",
                      mixBlendMode: "multiply",
                      pointerEvents: "none",
                      zIndex: 10,
                    }}
                  />
                )}
                <div
                  style={{
                    width: 44, height: 44, borderRadius: "50%",
                    background: isActive ? dim : dark ? "#1a1a1b" : "#ebebed",
                    boxShadow: isActive
                      ? dark
                        ? `inset 0 2px 8px rgba(0,0,0,0.6), 0 0 20px ${cfg.glow}, 0 0 40px ${cfg.glow}`
                        : `inset 0 2px 8px rgba(0,0,0,0.08), 0 0 10px ${cfg.glow}`
                      : `inset 0 2px 8px ${dark ? "rgba(0,0,0,0.7)" : "rgba(0,0,0,0.1)"}`,
                    border: `1px solid ${isActive ? cfg.active + "30" : dark ? "rgba(255,255,255,0.04)" : "rgba(0,0,0,0.06)"}`,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    cursor: "pointer", transition: "all 0.3s ease",
                  }}
                  onClick={() => handleManualSelect(light)}
                >
                  <div
                    className={isBreathing ? "light-breathe-red" : isBlinking ? "light-active" : ""}
                    style={{
                      width: 34, height: 34, borderRadius: "50%",
                      background: isActive
                        ? `radial-gradient(circle at 38% 36%, ${cfg.active}ff 0%, ${cfg.active}dd 40%, ${cfg.active}88 100%)`
                        : `radial-gradient(circle at 38% 36%, ${dim}cc 0%, ${dim}88 100%)`,
                      boxShadow: isActive
                        ? dark
                          ? `0 0 12px ${cfg.glow}, 0 0 4px ${cfg.innerGlow}, inset 0 1px 2px rgba(255,255,255,0.25)`
                          : `0 0 6px ${cfg.glow}, inset 0 1px 2px rgba(255,255,255,0.4)`
                        : `inset 0 1px 3px ${dark ? "rgba(0,0,0,0.5)" : "rgba(0,0,0,0.12)"}`,
                      transition: "all 0.4s ease",
                      display: "flex", alignItems: "center", justifyContent: "center",
                    }}
                  >
                    {isActive && light !== "red" ? (
                      <div style={{ width: 16, height: 10, borderRadius: "50%", background: "rgba(255,255,255,0.35)", marginTop: 10, filter: "blur(2px)" }} />
                    ) : null}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
        )}

        {/* 上方角标用量展示 */}
        {renderUsageSlot("top")}

        {/* 下方角标用量展示 */}
        {renderUsageSlot("bottom")}
      </div>
    </div>
  );
}
