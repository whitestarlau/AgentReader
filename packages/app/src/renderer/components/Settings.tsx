import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type {
	AiConfig,
	CustomProvider,
	SkillRuntimeInfo,
	SkillsPayload,
	SkillTrustPayload,
	WebSearchTestResult,
} from "../types.ts";
import { formatTokens } from "../tokens.ts";
import { Icon, type IconName } from "./Icons.tsx";

const EMPTY_FORM = { id: "", name: "", baseUrl: "", models: "", key: "" };

/** Human label for where a model's context window came from. */
function contextSourceLabel(
	source?: "override" | "catalog" | "metadata" | "inferred" | "default",
): string {
	switch (source) {
		case "override":
			return "手动";
		case "catalog":
			return "内置";
		case "metadata":
			return "目录";
		case "inferred":
			return "自动";
		default:
			return "默认";
	}
}

type SectionId = "models" | "custom" | "websearch" | "skills" | "agent" | "reading" | "config";

type SectionDef = { id: SectionId; label: string; icon: IconName; desc: string };

/** Settings are grouped by intent so the nav reads as a short outline. */
const SECTION_GROUPS: { title: string; items: SectionDef[] }[] = [
	{
		title: "模型与服务",
		items: [
			{
				id: "models",
				label: "模型与提供商",
				icon: "sparkle",
				desc: "选择提供商与全局默认模型。密钥加密保存在本机，也可以用环境变量提供。",
			},
			{
				id: "custom",
				label: "OpenAI 兼容",
				icon: "plus",
				desc: "接入自建或第三方的 OpenAI 兼容服务，配置独立保存，不改动 models.json。",
			},
			{
				id: "websearch",
				label: "联网搜索",
				icon: "search",
				desc: "让模型在书中内容不足时联网检索，补充上下文。",
			},
		],
	},
	{
		title: "使用",
		items: [
			{
				id: "skills",
				label: "技能",
				icon: "tool",
				desc: "导入 SKILL.md 技能，并按书决定是否启用。",
			},
			{
				id: "agent",
				label: "对话",
				icon: "chat",
				desc: "控制单次回答最多经过多少轮检索与工具调用。",
			},
			{
				id: "reading",
				label: "阅读",
				icon: "book",
				desc: "文字识别（OCR）等版面解析选项。",
			},
		],
	},
	{
		title: "高级",
		items: [
			{
				id: "config",
				label: "配置文件",
				icon: "file",
				desc: "直接编辑 models.json。文件允许注释，适合手动微调。",
			},
		],
	},
];

const SECTIONS: SectionDef[] = SECTION_GROUPS.flatMap((g) => g.items);

/** A bordered group of related settings. */
function Card({
	title,
	desc,
	actions,
	children,
	className,
}: {
	title?: ReactNode;
	desc?: ReactNode;
	actions?: ReactNode;
	children: ReactNode;
	className?: string;
}) {
	return (
		<section className={className ? `settings-card ${className}` : "settings-card"}>
			{title || actions ? (
				<header className="settings-card-head">
					<div className="settings-card-heading">
						{title ? <h4>{title}</h4> : null}
						{desc ? <div className="settings-card-desc">{desc}</div> : null}
					</div>
					{actions ? <div className="settings-card-actions">{actions}</div> : null}
				</header>
			) : null}
			{children}
		</section>
	);
}

/** One labelled setting row: label on the left, control on the right. */
function Field({
	label,
	hint,
	controlHint,
	children,
	stack,
}: {
	label: ReactNode;
	hint?: ReactNode;
	controlHint?: ReactNode;
	children: ReactNode;
	stack?: boolean;
}) {
	return (
		<div className={stack ? "settings-field stack" : "settings-field"}>
			<div className="settings-label">
				<span className="settings-label-text">{label}</span>
				{hint ? <span className="settings-label-hint">{hint}</span> : null}
			</div>
			<div className="settings-control">
				{children}
				{controlHint ? <div className="settings-hint">{controlHint}</div> : null}
			</div>
		</div>
	);
}

function Switch({
	checked,
	onChange,
	disabled,
	label,
}: {
	checked: boolean;
	onChange: (next: boolean) => void;
	disabled?: boolean;
	label: string;
}) {
	return (
		<input
			type="checkbox"
			role="switch"
			className="settings-switch"
			aria-label={label}
			checked={checked}
			disabled={disabled}
			onChange={(e) => onChange(e.target.checked)}
		/>
	);
}

export function Settings({
	docId,
	onClose,
	onSaved,
}: {
	docId?: string | null;
	onClose: () => void;
	onSaved?: () => void;
}) {
	const [ai, setAi] = useState<AiConfig | null>(null);
	const [custom, setCustom] = useState<Record<string, CustomProvider>>({});
	const [ocrLang, setOcrLang] = useState("chi_sim+eng");
	const [providerId, setProviderId] = useState("");
	const [key, setKey] = useState("");
	const [form, setForm] = useState(EMPTY_FORM);
	const [configText, setConfigText] = useState("");
	const [errors, setErrors] = useState<string[]>([]);
	const [busy, setBusy] = useState(false);
	const [metaSyncing, setMetaSyncing] = useState(false);
	const [note, setNote] = useState<string | null>(null);
	const [wsEnabled, setWsEnabled] = useState(false);
	const [wsBackend, setWsBackend] = useState("auto");
	const [wsMax, setWsMax] = useState(5);
	const [wsKey, setWsKey] = useState("");
	const [wsTest, setWsTest] = useState<WebSearchTestResult | null>(null);
	const [skills, setSkills] = useState<SkillsPayload>({ skills: [], diagnostics: [] });
	const [enabledSkills, setEnabledSkills] = useState<string[]>([]);
	const [trustedSkills, setTrustedSkills] = useState<string[]>([]);
	const [executionEnabled, setExecutionEnabled] = useState(false);
	const [runtime, setRuntime] = useState<SkillRuntimeInfo | null>(null);
	const [maxTurns, setMaxTurns] = useState(8);
	const [section, setSection] = useState<SectionId>("models");
	const contentRef = useRef<HTMLDivElement | null>(null);

	const load = useCallback(async () => {
		const [config, settings, customs, skillsData, docSkills, trust, rt] = await Promise.all([
			window.api.getAiConfig(),
			window.api.getSettings(),
			window.api.listCustomProviders(),
			window.api.listSkills(),
			docId ? window.api.getDocSkills(docId) : Promise.resolve<string[]>([]),
			window.api.getSkillTrust(),
			window.api.getSkillRuntime(),
		]);
		setAi(config);
		setCustom(customs);
		setConfigText((prev) => (prev === "" ? config.text : prev));
		setErrors(config.errors);
		if (settings.ocrLang) setOcrLang(settings.ocrLang);
		setWsEnabled(config.webSearch.enabled);
		setWsBackend(config.webSearch.backend);
		setWsMax(config.webSearch.maxResults);
		setSkills(skillsData);
		setEnabledSkills(docSkills);
		setTrustedSkills(trust.trusted);
		setExecutionEnabled(trust.executionEnabled);
		setRuntime(rt);
		setMaxTurns(settings.agentMaxTurns ? Number(settings.agentMaxTurns) || 8 : 8);
		setProviderId((prev) => {
			if (prev) return prev;
			const active = config.defaultModel?.split("/")[0];
			return active ?? config.providers.find((p) => p.configured)?.id ?? config.providers[0]?.id ?? "";
		});
	}, [docId]);

	useEffect(() => {
		load().catch(() => {});
	}, [load]);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);

	// Transient feedback belongs in the footer: clear it instead of letting it linger.
	useEffect(() => {
		if (!note) return;
		const timer = window.setTimeout(() => setNote(null), 6000);
		return () => window.clearTimeout(timer);
	}, [note]);

	const provider = useMemo(() => ai?.providers.find((p) => p.id === providerId), [ai, providerId]);
	const activeRef = ai?.defaultModel ?? "";
	const providerModels = useMemo(
		() => (ai?.models ?? []).filter((m) => m.provider === providerId),
		[ai, providerId],
	);
	const currentInProvider = providerId && activeRef.startsWith(`${providerId}/`) ? activeRef : "";
	const overrideCount = useMemo(() => {
		const overrides = ai?.modelOverrides?.[providerId] ?? {};
		return providerModels.filter((m) => overrides[m.id]).length;
	}, [ai, providerId, providerModels]);
	const notify = () => onSaved?.();

	// Each section is its own panel, so start it at the top.
	const goTo = (id: SectionId) => {
		if (id !== section) contentRef.current?.scrollTo({ top: 0 });
		setSection(id);
	};

	const chooseProvider = (id: string) => {
		// The key field belongs to one provider only: never carry it across.
		setKey("");
		setProviderId(id);
	};

	const saveKey = async () => {
		if (!providerId) return;
		setBusy(true);
		try {
			await window.api.setProviderKey(providerId, key.trim());
			setKey("");
			setNote(key.trim() ? `已保存 ${providerId} 的 API Key` : `已清除 ${providerId} 的 API Key`);
			await load();
			notify();
		} finally {
			setBusy(false);
		}
	};

	const selectModel = async (ref: string) => {
		if (!ref) return;
		await window.api.setModel(ref);
		await load();
		notify();
	};

	// Per-model overrides: only the fields the user actually changes are stored;
	// blank fields fall back to the catalog/default value.
	const saveModelOverride = async (
		providerId: string,
		modelId: string,
		patch: { contextWindow?: number; maxTokens?: number },
	) => {
		await window.api.setModelOverride(providerId, modelId, patch);
		await load();
	};

	const resetModelOverride = async (providerId: string, modelId: string) => {
		await window.api.clearModelOverride(providerId, modelId);
		await load();
	};

	const syncMeta = async () => {
		setMetaSyncing(true);
		setNote("正在同步模型目录（models.dev）…");
		try {
			const r = await window.api.syncModelMetadata();
			if (r.ok) {
				setNote(`已同步模型目录：${r.count} 个模型`);
				await load();
			} else {
				setNote(`同步失败：${r.error ?? "未知错误"}`);
			}
		} finally {
			setMetaSyncing(false);
		}
	};

	const saveCustom = async () => {
		setBusy(true);
		try {
			const modelIds = form.models
				.split(/[\n,，;；]/)
				.map((s) => s.trim())
				.filter(Boolean);
			const result = await window.api.saveCustomProvider({
				id: form.id,
				name: form.name,
				baseUrl: form.baseUrl,
				models: modelIds,
			});
			if (!result.ok || !result.id) {
				setNote(result.error ?? "保存失败");
				return;
			}
			if (form.key.trim()) await window.api.setProviderKey(result.id, form.key.trim());
			// Make it immediately usable: current model = first model of the new provider.
			if (modelIds[0]) await window.api.setModel(`${result.id}/${modelIds[0]}`);
			setForm(EMPTY_FORM);
			setProviderId(result.id);
			await load();
			notify();
			setNote(`已保存 OpenAI 兼容提供商 ${result.id}`);
		} finally {
			setBusy(false);
		}
	};

	const editCustom = (id: string) => {
		const c = custom[id];
		if (!c) return;
		setForm({
			id,
			name: c.name ?? "",
			baseUrl: c.baseUrl,
			models: c.models.map((m) => m.id).join(", "),
			key: "",
		});
		setProviderId(id);
		goTo("custom");
	};

	const removeCustom = async (id: string) => {
		if (!confirm(`删除提供商 ${id}？`)) return;
		await window.api.removeCustomProvider(id);
		if (providerId === id) setProviderId("");
		if (form.id === id) setForm(EMPTY_FORM);
		await load();
		notify();
		setNote(`已删除 ${id}`);
	};

	const saveWebSearch = async (patch: { enabled?: boolean; backend?: string; maxResults?: number }) => {
		await window.api.setWebSearch(patch);
		await load();
	};

	const chooseWsBackend = (backend: string) => {
		setWsBackend(backend);
		setWsKey("");
		saveWebSearch({ backend });
	};

	const saveWsKey = async () => {
		if (!wsKey.trim()) return;
		await window.api.setProviderKey(`websearch:${wsBackend}`, wsKey.trim());
		setWsKey("");
		setNote(`已保存 ${wsBackend} 的搜索 Key`);
		await load();
	};

	const runWsTest = async () => {
		setBusy(true);
		setWsTest(null);
		try {
			setWsTest(await window.api.testWebSearch());
		} finally {
			setBusy(false);
		}
	};

	const importSkill = async () => {
		setBusy(true);
		try {
			const result = await window.api.importSkill();
			if (result.canceled) return;
			setSkills(result.skills);
			setNote(result.ok ? `已导入技能 ${result.name}` : `导入失败：${result.error}`);
		} finally {
			setBusy(false);
		}
	};

	const removeSkill = async (name: string) => {
		if (!confirm(`删除技能「${name}」？`)) return;
		setSkills(await window.api.deleteSkill(name));
		setEnabledSkills((prev) => prev.filter((n) => n !== name));
		setNote(`已删除技能 ${name}`);
	};

	const toggleSkill = async (name: string, on: boolean) => {
		if (!docId) return;
		const next = on ? [...new Set([...enabledSkills, name])] : enabledSkills.filter((n) => n !== name);
		setEnabledSkills(next);
		await window.api.setDocSkills(docId, next);
	};

	const toggleExecution = async (on: boolean) => {
		setExecutionEnabled(on);
		await window.api.setSkillExecution(on);
	};

	const toggleTrust = async (name: string, on: boolean) => {
		setTrustedSkills(await window.api.setSkillTrust(name, on));
	};

	const refresh = async () => {
		setBusy(true);
		setNote("正在拉取模型列表…");
		try {
			const results = await window.api.refreshModels();
			const ok = results.filter((r) => r.added).map((r) => `${r.provider}(${r.added})`);
			const failed = results.filter((r) => r.error).map((r) => `${r.provider}: ${r.error}`);
			setNote(
				`刷新完成${ok.length ? `：${ok.join("、")}` : ""}${failed.length ? `；失败 ${failed.join("；")}` : ""}`,
			);
			await load();
		} finally {
			setBusy(false);
		}
	};

	const reloadConfig = async () => {
		const c = await window.api.getAiConfig();
		setAi(c);
		setConfigText(c.text);
		setErrors(c.errors);
	};

	const saveConfig = async () => {
		const result = await window.api.saveAiConfig(configText);
		setErrors(result.errors);
		if (result.ok) {
			setNote("models.json 已保存");
			await load();
		}
	};

	const saveOcrLang = async () => {
		const value = ocrLang.trim();
		if (value) await window.api.saveSettings({ ocrLang: value });
	};

	const done = async () => {
		// Safety net: if the user typed a key but did not press "保存 Key", apply it now.
		if (providerId && key.trim()) await window.api.setProviderKey(providerId, key.trim());
		await saveOcrLang();
		onSaved?.();
		onClose();
	};

	const providers = ai?.providers ?? [];
	const sectionDef = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0];
	const customEntries = Object.entries(custom);

	return (
		<div className="modal-backdrop">
			{/* biome-ignore lint/a11y/useSemanticElements: custom modal surface */}
			<div className="modal settings-modal" role="dialog" aria-modal="true" aria-label="设置">
				<div className="modal-header settings-header">
					<Icon name="settings" size={15} />
					<span className="modal-title">设置</span>
					<span className="spacer" />
					<button type="button" className="icon-btn" onClick={onClose} title="关闭">
						<Icon name="close" size={14} />
					</button>
				</div>

				<div className="settings-body">
					<nav className="settings-nav" aria-label="设置分类">
						{SECTION_GROUPS.map((group) => (
							<div className="settings-nav-group" key={group.title}>
								<div className="settings-nav-title">{group.title}</div>
								{group.items.map((item) => (
									<button
										type="button"
										key={item.id}
										className={`settings-nav-item${section === item.id ? " active" : ""}`}
										aria-current={section === item.id ? "page" : undefined}
										onClick={() => goTo(item.id)}
									>
										<Icon name={item.icon} size={14} />
										<span>{item.label}</span>
									</button>
								))}
							</div>
						))}
					</nav>

					<div
						ref={contentRef}
						className={`settings-content${section === "config" ? " settings-content-fixed" : ""}`}
					>
						<div className={`settings-panel${section === "config" ? " is-config" : ""}`}>
							<header className="settings-panel-head">
								<h3>{sectionDef.label}</h3>
								<p>{sectionDef.desc}</p>
							</header>

							{section === "models" && (
								<>
									<Card>
										<Field
											label="提供商"
											controlHint={
												provider
													? `${provider.baseUrl || "未设置 Base URL"} · ${provider.api} · ${provider.modelCount} 个模型`
													: "请选择一个提供商"
											}
										>
											<select value={providerId} onChange={(e) => chooseProvider(e.target.value)}>
												{providers.map((p) => (
													<option key={p.id} value={p.id}>
														{p.name}
														{p.source === "gui"
															? "（手动添加）"
															: p.source === "file"
																? "（models.json）"
																: ""}
														{p.configured ? " ✓" : ""}
													</option>
												))}
											</select>
										</Field>

										<Field
											label="当前模型"
											controlHint={
												providerModels.length > 0
													? "选中后即作为全局默认模型，对所有对话生效"
													: "该提供商暂无可用模型"
											}
										>
											<select value={currentInProvider} onChange={(e) => selectModel(e.target.value)}>
												{currentInProvider === "" && <option value="">— 选择一个模型 —</option>}
												{providerModels.length === 0 && <option value="">（该提供商无模型）</option>}
												{providerModels.map((m) => (
													<option key={m.ref} value={m.ref}>
														{m.label}
														{m.configured ? "" : "（未配置 Key）"}
													</option>
												))}
											</select>
										</Field>

										<Field
											label="API Key"
											hint="仅保存在本机"
											controlHint={
												provider?.keySource === "stored"
													? "已保存，留空保持不变"
													: provider?.keySource === "env"
														? "来自环境变量"
														: "尚未配置密钥"
											}
										>
											<input
												type="password"
												value={key}
												onChange={(e) => setKey(e.target.value)}
												onKeyDown={(e) => {
													if (e.key === "Enter") saveKey();
												}}
												placeholder={provider?.configured ? "留空则保持不变" : "sk-..."}
											/>
											<div className="button-row">
												<button type="button" onClick={saveKey} disabled={busy || !providerId}>
													保存 Key
												</button>
												<button type="button" onClick={refresh} disabled={busy}>
													刷新模型列表
												</button>
											</div>
										</Field>
									</Card>

									{providerModels.length > 0 && (
										<details className="settings-card settings-card-collapsible">
											<summary className="settings-card-summary">
												<Icon name="chevronRight" size={12} className="settings-chevron" />
												<span className="settings-card-title">模型上下文</span>
												<span className="settings-card-sub">窗口大小已自动识别，可手动覆盖</span>
												<span className="spacer" />
												{overrideCount > 0 ? (
													<span className="settings-pill accent">{overrideCount} 项覆盖</span>
												) : null}
											</summary>

											<div className="settings-toolbar">
												<span className="settings-hint">
													模型目录：
													{ai?.metadataUpdatedAt
														? new Date(ai.metadataUpdatedAt).toLocaleString()
														: "未同步（启动时自动尝试）"}
												</span>
												<button type="button" onClick={syncMeta} disabled={metaSyncing}>
													{metaSyncing ? "同步中…" : "同步 models.dev"}
												</button>
											</div>

											<div className="settings-table">
												<div className="settings-table-head ctx">
													<span>模型</span>
													<span>来源</span>
													<span>上下文窗口</span>
													<span>最大输出</span>
													<span />
												</div>
												{providerModels.map((m) => {
													const ov = ai?.modelOverrides?.[m.provider]?.[m.id];
													return (
														<div className="settings-table-row ctx" key={m.ref}>
															<span className="settings-model-name" title={m.ref}>
																{m.label}
															</span>
															<span
																className={`settings-pill src-${m.contextSource ?? "default"}`}
																title="上下文窗口来源"
															>
																{contextSourceLabel(m.contextSource)}
															</span>
															<input
																key={`${m.ref}:ctx:${ov?.contextWindow ?? ""}`}
																type="number"
																min={1}
																aria-label={`${m.label} 上下文窗口`}
																className="settings-number"
																defaultValue={ov?.contextWindow ?? ""}
																placeholder={formatTokens(m.contextWindow)}
																title="覆盖上下文窗口（token），留空用自动值"
																onBlur={(e) => {
																	const v = Number(e.target.value);
																	saveModelOverride(m.provider, m.id, {
																		contextWindow:
																			e.target.value.trim() && Number.isFinite(v) && v > 0
																				? Math.floor(v)
																				: undefined,
																		maxTokens: ov?.maxTokens,
																	});
																}}
															/>
															<input
																key={`${m.ref}:max:${ov?.maxTokens ?? ""}`}
																type="number"
																min={1}
																aria-label={`${m.label} 最大输出`}
																className="settings-number"
																defaultValue={ov?.maxTokens ?? ""}
																placeholder={m.maxTokens ? formatTokens(m.maxTokens) : "默认"}
																title="覆盖最大输出 token，留空用自动值"
																onBlur={(e) => {
																	const v = Number(e.target.value);
																	saveModelOverride(m.provider, m.id, {
																		contextWindow: ov?.contextWindow,
																		maxTokens:
																			e.target.value.trim() && Number.isFinite(v) && v > 0
																				? Math.floor(v)
																				: undefined,
																	});
																}}
															/>
															{ov ? (
																<button
																	type="button"
																	className="settings-link"
																	onClick={() => resetModelOverride(m.provider, m.id)}
																>
																	重置
																</button>
															) : null}
														</div>
													);
												})}
											</div>

											<p className="settings-card-note">
												留空即使用自动识别值。数据参考 models.dev 与公开模型卡片，仅作默认。
											</p>
										</details>
									)}
								</>
							)}

							{section === "custom" && (
								<>
									<Card
										title={form.id && custom[form.id] ? "编辑提供商" : "添加提供商"}
										desc="填写 Base URL 与模型 ID 即可开始使用。"
									>
										<Field label="标识 ID" hint="小写字母、数字与连字符">
											<input
												value={form.id}
												onChange={(e) => setForm({ ...form, id: e.target.value })}
												placeholder="my-llm"
											/>
										</Field>
										<Field label="显示名称">
											<input
												value={form.name}
												onChange={(e) => setForm({ ...form, name: e.target.value })}
												placeholder="本地 vLLM"
											/>
										</Field>
										<Field label="Base URL">
											<input
												value={form.baseUrl}
												onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
												placeholder="http://127.0.0.1:8000/v1"
											/>
										</Field>
										<Field label="模型 ID" hint="逗号或换行分隔">
											<input
												value={form.models}
												onChange={(e) => setForm({ ...form, models: e.target.value })}
												placeholder="qwen3-32b, qwen3-8b"
											/>
										</Field>
										<Field label="API Key" hint="可选">
											<input
												type="password"
												value={form.key}
												onChange={(e) => setForm({ ...form, key: e.target.value })}
												placeholder={form.id && custom[form.id] ? "留空则保持不变" : "sk-..."}
											/>
										</Field>

										<div className="settings-actions">
											{form.id && (
												<button type="button" onClick={() => setForm(EMPTY_FORM)}>
													清空
												</button>
											)}
											<button type="button" className="primary" onClick={saveCustom} disabled={busy}>
												{form.id && custom[form.id] ? "更新提供商" : "保存提供商"}
											</button>
										</div>
									</Card>

									<Card
										title="已添加的提供商"
										desc={`共 ${customEntries.length} 个 · 保存在 custom-providers.json`}
									>
										{customEntries.length === 0 ? (
											<div className="settings-empty">
												还没有手动添加的提供商。填写上方表单即可添加。
											</div>
										) : (
											<div className="settings-list">
												{customEntries.map(([id, c]) => (
													<div key={id} className="settings-list-item">
														<div className="settings-list-main">
															<span className="settings-list-title">{c.name ?? id}</span>
															<span className="settings-list-meta" title={`${id} · ${c.baseUrl}`}>
																{id} · {c.baseUrl} · {c.models.length} 个模型
															</span>
														</div>
														<div className="settings-list-actions">
															<button type="button" onClick={() => editCustom(id)}>
																编辑
															</button>
															<button type="button" onClick={() => removeCustom(id)}>
																删除
															</button>
														</div>
													</div>
												))}
											</div>
										)}
									</Card>
								</>
							)}

							{section === "websearch" && (
								<>
									<Card>
										<Field label="启用联网搜索" hint="关闭后模型无法调用 web_search">
											<Switch
												label="启用联网搜索"
												checked={wsEnabled}
												onChange={(enabled) => saveWebSearch({ enabled })}
											/>
										</Field>

										<Field label="搜索后端" controlHint="「自动」优先使用免密钥的公开 MCP，失败时自动切换">
											<select value={wsBackend} onChange={(e) => chooseWsBackend(e.target.value)}>
												<option value="auto">自动（Exa / Parallel 公开 MCP，免 key）</option>
												<option value="exa-mcp">Exa（公开 MCP，免 key）</option>
												<option value="parallel-mcp">Parallel（公开 MCP，免 key）</option>
												<option value="brave">Brave Search（需 key）</option>
												<option value="tavily">Tavily（需 key）</option>
												<option value="exa">Exa API（需 key）</option>
												<option value="duckduckgo">DuckDuckGo（免 key，兜底）</option>
												<option value="native">服务商原生（仅 Anthropic 协议）</option>
											</select>
										</Field>

										<Field
											label="API Key"
											hint="仅在使用需 key 的后端时填写"
											controlHint={
												ai?.webSearch.keySource === "stored"
													? "已保存，留空保持不变"
													: ai?.webSearch.keySource === "env"
														? "来自环境变量"
														: ai?.webSearch.keySource === "config"
															? "来自 models.json"
															: "当前后端无需 Key"
											}
										>
											<input
												type="password"
												value={wsKey}
												onChange={(e) => setWsKey(e.target.value)}
												onKeyDown={(e) => {
													if (e.key === "Enter") saveWsKey();
												}}
												placeholder="搜索服务 API Key"
											/>
											<div className="button-row">
												<button type="button" onClick={saveWsKey} disabled={busy || !wsKey.trim()}>
													保存 Key
												</button>
												<button type="button" onClick={runWsTest} disabled={busy}>
													测试搜索
												</button>
											</div>
										</Field>

										<Field label="返回条数" hint="1–10 条">
											<input
												type="number"
												min={1}
												max={10}
												className="settings-number"
												value={wsMax}
												onChange={(e) => setWsMax(Number(e.target.value) || 5)}
												onBlur={() => saveWebSearch({ maxResults: wsMax })}
											/>
										</Field>
									</Card>

									{wsTest && (
										<Card
											title="测试结果"
											actions={
												<span className={`settings-pill ${wsTest.ok ? "ok" : "bad"}`}>
													{wsTest.ok ? "连接正常" : "调用失败"}
												</span>
											}
										>
											<div className="settings-card-body">
												{wsTest.ok ? (
													<>
														<div className="settings-hint">
															后端 {wsTest.backend}
															{wsTest.results?.length
																? ` 返回 ${wsTest.results.length} 条：`
																: " 返回文本："}
														</div>
														{wsTest.results?.length ? (
															<ul className="ws-test-list">
																{wsTest.results.slice(0, 3).map((r) => (
																	<li key={r.url}>
																		<span>{r.title}</span>
																		<span className="settings-hint"> {r.url}</span>
																	</li>
																))}
															</ul>
														) : (
															<pre className="ws-test-text">
																{(wsTest.text ?? "（无内容）").slice(0, 1200)}
															</pre>
														)}
													</>
												) : (
													<div className="settings-error">测试失败：{wsTest.error}</div>
												)}
											</div>
										</Card>
									)}
								</>
							)}

							{section === "skills" && (
								<>
									<Card>
										<Field
											label="允许执行技能脚本"
											hint="关闭时模型看不到 run_skill_script"
											controlHint={
												runtime
													? `运行环境：Python ${runtime.python ?? "未检测到"} · Node ${runtime.node}`
													: undefined
											}
										>
											<Switch
												label="允许执行技能脚本"
												checked={executionEnabled}
												onChange={toggleExecution}
											/>
										</Field>
									</Card>

									<Card
										title="已安装技能"
										desc={
											skills.skills.length > 0
												? `${skills.skills.length} 个 · 勾选后在当前书中启用`
												: "导入 SKILL.md 或包含 SKILL.md 的文件夹 / .zip"
										}
										actions={
											<button type="button" className="primary" onClick={importSkill} disabled={busy}>
												导入技能
											</button>
										}
									>
										{skills.diagnostics.length > 0 && (
											<div className="settings-error">已跳过：{skills.diagnostics.join("；")}</div>
										)}

										{skills.skills.length === 0 ? (
											<div className="settings-empty">还没有导入任何技能。</div>
										) : (
											<div className="settings-table">
												<div className="settings-table-head skill">
													<span>本书启用</span>
													<span>技能</span>
													<span>免确认</span>
													<span />
												</div>
												{skills.skills.map((s) => (
													<div key={s.name} className="settings-table-row skill">
														<input
															type="checkbox"
															aria-label={`${s.name} 在本书启用`}
															checked={enabledSkills.includes(s.name)}
															disabled={!docId}
															onChange={(e) => toggleSkill(s.name, e.target.checked)}
														/>
														<div className="settings-skill-main">
															<span className="settings-skill-name">{s.name}</span>
															<span className="settings-skill-desc">{s.description}</span>
														</div>
														<input
															type="checkbox"
															aria-label={`${s.name} 执行时不再确认`}
															checked={trustedSkills.includes(s.name)}
															disabled={!executionEnabled}
															title={
																executionEnabled
																	? "勾选后，该技能执行脚本不再弹窗确认"
																	: "需先允许执行技能脚本"
															}
															onChange={(e) => toggleTrust(s.name, e.target.checked)}
														/>
														<button
															type="button"
															className="settings-link danger"
															onClick={() => removeSkill(s.name)}
														>
															删除
														</button>
													</div>
												))}
											</div>
										)}
										{!docId && skills.skills.length > 0 && (
											<div className="settings-card-note">打开一本书后，即可针对该书勾选技能。</div>
										)}
									</Card>
								</>
							)}

							{section === "agent" && (
								<Card>
									<Field
										label="最大工具回合数"
										hint="每条消息最多可进行的工具调用轮数"
										controlHint="1–20 轮，默认 8 轮。数值越大回答越深入，耗时也越长。"
									>
										<input
											type="number"
											min={1}
											max={20}
											className="settings-number"
											value={maxTurns}
											onChange={(e) => setMaxTurns(Number(e.target.value) || 8)}
											onBlur={() =>
												window.api.saveSettings({
													agentMaxTurns: String(Math.max(1, Math.min(20, maxTurns))),
												})
											}
										/>
									</Field>
								</Card>
							)}

							{section === "reading" && (
								<Card title="文字识别（OCR）">
									<Field
										label="OCR 语言"
										hint="Tesseract 语言包名"
										controlHint="多个语言用 + 连接，例如 chi_sim+eng / eng / jpn。改动后对新发起的识别生效。"
									>
										<input
											value={ocrLang}
											onChange={(e) => setOcrLang(e.target.value)}
											onBlur={saveOcrLang}
											placeholder="chi_sim+eng"
										/>
									</Field>
								</Card>
							)}

							{section === "config" && (
								<Card
									className="settings-code-card"
									title="models.json"
									desc="编辑后点击「保存配置」生效，语法错误会显示在编辑器上方。"
									actions={
										<>
											<button type="button" onClick={reloadConfig}>
												重新载入
											</button>
											<button type="button" onClick={() => window.api.openAiConfig()}>
												系统编辑器打开
											</button>
											<button type="button" className="primary" onClick={saveConfig}>
												保存配置
											</button>
										</>
									}
								>
									<div className="settings-filebar" title={ai?.path}>
										<Icon name="file" size={12} />
										<code>{ai?.path}</code>
									</div>
									<div className="settings-card-body settings-code-body">
										{errors.length > 0 && (
											<ul className="settings-errors">
												{errors.map((err) => (
													<li key={err}>{err}</li>
												))}
											</ul>
										)}
										<textarea
											className="settings-code"
											value={configText}
											onChange={(e) => setConfigText(e.target.value)}
											spellCheck={false}
										/>
									</div>
								</Card>
							)}
						</div>
					</div>
				</div>

				<div className="modal-footer settings-footer">
					<span className="settings-status" title={note ?? ""}>
						{note ?? ""}
					</span>
					<button type="button" onClick={onClose}>
						取消
					</button>
					<button type="button" className="primary" onClick={done}>
						完成
					</button>
				</div>
			</div>
		</div>
	);
}
