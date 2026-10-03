import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
	AiConfig,
	CustomProvider,
	SkillRuntimeInfo,
	SkillsPayload,
	SkillTrustPayload,
	WebSearchTestResult,
} from "../types.ts";
import { Icon } from "./Icons.tsx";

const EMPTY_FORM = { id: "", name: "", baseUrl: "", models: "", key: "" };

const SECTIONS = [
	{ id: "models", label: "模型与提供商" },
	{ id: "custom", label: "OpenAI 兼容" },
	{ id: "websearch", label: "联网搜索" },
	{ id: "skills", label: "技能" },
	{ id: "agent", label: "对话" },
	{ id: "reading", label: "阅读" },
	{ id: "config", label: "配置文件" },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

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
	const sectionRefs = useRef<Record<string, HTMLDivElement | null>>({});

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

	const provider = useMemo(() => ai?.providers.find((p) => p.id === providerId), [ai, providerId]);
	const activeRef = ai?.defaultModel ?? "";
	const providerModels = useMemo(
		() => (ai?.models ?? []).filter((m) => m.provider === providerId),
		[ai, providerId],
	);
	const currentInProvider = providerId && activeRef.startsWith(`${providerId}/`) ? activeRef : "";
	const notify = () => onSaved?.();

	const goTo = (id: SectionId) => {
		setSection(id);
		sectionRefs.current[id]?.scrollIntoView({ behavior: "smooth", block: "start" });
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

	const saveConfig = async () => {
		const result = await window.api.saveAiConfig(configText);
		setErrors(result.errors);
		if (result.ok) {
			setNote("models.json 已保存");
			await load();
		}
	};

	const done = async () => {
		// Safety net: if the user typed a key but did not press "保存 Key", apply it now.
		if (providerId && key.trim()) await window.api.setProviderKey(providerId, key.trim());
		await window.api.saveSettings({ ocrLang });
		onSaved?.();
		onClose();
	};

	const providers = ai?.providers ?? [];

	return (
		<div className="modal-backdrop">
			{/* biome-ignore lint/a11y/useSemanticElements: custom modal surface */}
			<div className="modal settings-modal" role="dialog" aria-modal="true" aria-label="设置">
				<div className="modal-header">
					<Icon name="settings" size={15} />
					<span className="modal-title">设置</span>
					<span className="spacer" />
					<button type="button" className="icon-btn" onClick={onClose} title="关闭">
						<Icon name="close" size={14} />
					</button>
				</div>

				<div className="settings-body">
					<nav className="settings-nav">
						{SECTIONS.map((s) => (
							<button
								type="button"
								key={s.id}
								className={section === s.id ? "active" : ""}
								onClick={() => goTo(s.id)}
							>
								{s.label}
							</button>
						))}
					</nav>

					<div className="settings-content">
						<div
							className="settings-section"
							ref={(el) => {
								sectionRefs.current.models = el;
							}}
						>
							<h3>模型与提供商</h3>
							<p className="section-desc">
								选择提供商与全局默认模型。密钥加密保存在本机，可用环境变量替代。
							</p>

							<div className="setting">
								<div className="setting-label">
									提供商
									<span className="hint">
										{provider
											? `${provider.baseUrl || "未设置 Base URL"} · ${provider.api} · ${provider.modelCount} 个模型`
											: "选择一个提供商"}
									</span>
								</div>
								<div className="setting-control">
									<select value={providerId} onChange={(e) => setProviderId(e.target.value)}>
										{providers.map((p) => (
											<option key={p.id} value={p.id}>
												{p.name}{" "}
												{p.source === "gui" ? "(手动添加)" : p.source === "file" ? "(models.json)" : ""}
												{p.configured ? " ✓" : ""}
											</option>
										))}
									</select>
								</div>
							</div>

							<div className="setting">
								<div className="setting-label">
									当前模型
									<span className="hint">
										{provider?.name ?? "—"} · 共 {providerModels.length} 个，选中即全局默认
									</span>
								</div>
								<div className="setting-control">
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
								</div>
							</div>

							<div className="setting">
								<div className="setting-label">
									API Key
									<span className="hint">
										{provider?.keySource === "stored"
											? "已保存（留空保持不变）"
											: provider?.keySource === "env"
												? "来自环境变量"
												: "尚未配置"}
									</span>
								</div>
								<div className="setting-control">
									<input
										type="password"
										value={key}
										onChange={(e) => setKey(e.target.value)}
										onKeyDown={(e) => {
											if (e.key === "Enter") saveKey();
										}}
										placeholder={provider?.configured ? "留空则保持不变" : "sk-..."}
									/>
									<div className="button-row" style={{ marginTop: 6 }}>
										<button type="button" onClick={saveKey} disabled={busy || !providerId}>
											保存 Key
										</button>
										<button type="button" onClick={refresh} disabled={busy}>
											刷新模型列表
										</button>
									</div>
								</div>
							</div>
						</div>

						<div
							className="settings-section"
							ref={(el) => {
								sectionRefs.current.custom = el;
							}}
						>
							<h3>OpenAI 兼容</h3>
							<p className="section-desc">
								手动添加自建/第三方 OpenAI 兼容服务，填写 Base URL 与模型 ID 即可。保存到
								custom-providers.json，不改动 models.json。
							</p>

							<div className="setting">
								<div className="setting-label">标识 ID</div>
								<div className="setting-control">
									<input
										value={form.id}
										onChange={(e) => setForm({ ...form, id: e.target.value })}
										placeholder="my-llm"
									/>
								</div>
							</div>
							<div className="setting">
								<div className="setting-label">显示名称</div>
								<div className="setting-control">
									<input
										value={form.name}
										onChange={(e) => setForm({ ...form, name: e.target.value })}
										placeholder="本地 vLLM"
									/>
								</div>
							</div>
							<div className="setting">
								<div className="setting-label">Base URL</div>
								<div className="setting-control">
									<input
										value={form.baseUrl}
										onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
										placeholder="http://127.0.0.1:8000/v1"
									/>
								</div>
							</div>
							<div className="setting">
								<div className="setting-label">
									模型 ID
									<span className="hint">逗号或换行分隔</span>
								</div>
								<div className="setting-control">
									<input
										value={form.models}
										onChange={(e) => setForm({ ...form, models: e.target.value })}
										placeholder="qwen3-32b, qwen3-8b"
									/>
								</div>
							</div>
							<div className="setting">
								<div className="setting-label">API Key（可选）</div>
								<div className="setting-control">
									<input
										type="password"
										value={form.key}
										onChange={(e) => setForm({ ...form, key: e.target.value })}
										placeholder={form.id && custom[form.id] ? "留空则保持不变" : "sk-..."}
									/>
								</div>
							</div>

							<div className="button-row" style={{ marginTop: 10 }}>
								<button type="button" className="primary" onClick={saveCustom} disabled={busy}>
									{form.id && custom[form.id] ? "更新提供商" : "保存提供商"}
								</button>
								{form.id && (
									<button type="button" onClick={() => setForm(EMPTY_FORM)}>
										清空
									</button>
								)}
							</div>

							{Object.keys(custom).length > 0 && (
								<div className="custom-list">
									{Object.entries(custom).map(([id, c]) => (
										<div key={id} className="custom-item">
											<span className="custom-item-label" title={`${id} · ${c.baseUrl}`}>
												<strong>{c.name ?? id}</strong>
												<span className="hint">
													{" "}
													{id} · {c.baseUrl} · {c.models.length} 个模型
												</span>
											</span>
											<span className="button-row">
												<button type="button" onClick={() => editCustom(id)}>
													编辑
												</button>
												<button type="button" onClick={() => removeCustom(id)}>
													删除
												</button>
											</span>
										</div>
									))}
								</div>
							)}
						</div>

						<div
							className="settings-section"
							ref={(el) => {
								sectionRefs.current.websearch = el;
							}}
						>
							<h3>联网搜索</h3>
							<p className="section-desc">
								为对话提供 web_search 工具。默认「自动」走 Exa / Parallel 的公开 MCP（免 key，失败会互相切换）；
								也可改用 Brave / Tavily / Exa API（需 key）；「服务商原生」由 Anthropic 协议模型在服务端执行。
							</p>

							<div className="setting">
								<div className="setting-label">
									启用
									<span className="hint">允许模型在书中内容不足时联网</span>
								</div>
								<div className="setting-control">
									<label className="checkbox-line">
										<input
											type="checkbox"
											checked={wsEnabled}
											onChange={(e) => saveWebSearch({ enabled: e.target.checked })}
										/>
										启用联网搜索
									</label>
								</div>
							</div>

							<div className="setting">
								<div className="setting-label">后端</div>
								<div className="setting-control">
									<select
										value={wsBackend}
										onChange={(e) => saveWebSearch({ backend: e.target.value })}
									>
										<option value="auto">自动（Exa / Parallel 公开 MCP，免 key）</option>
										<option value="exa-mcp">Exa（公开 MCP，免 key）</option>
										<option value="parallel-mcp">Parallel（公开 MCP，免 key）</option>
										<option value="brave">Brave Search（需 key）</option>
										<option value="tavily">Tavily（需 key）</option>
										<option value="exa">Exa API（需 key）</option>
										<option value="duckduckgo">DuckDuckGo（免 key，兜底）</option>
										<option value="native">服务商原生（仅 Anthropic 协议）</option>
									</select>
								</div>
							</div>

							<div className="setting">
								<div className="setting-label">
									API Key
									<span className="hint">
										{ai?.webSearch.keySource === "stored"
											? "已保存（留空保持不变）"
											: ai?.webSearch.keySource === "env"
												? "来自环境变量"
												: ai?.webSearch.keySource === "config"
													? "来自 models.json"
													: "DuckDuckGo / 原生无需"}
									</span>
								</div>
								<div className="setting-control">
									<input
										type="password"
										value={wsKey}
										onChange={(e) => setWsKey(e.target.value)}
										onKeyDown={(e) => {
											if (e.key === "Enter") saveWsKey();
										}}
										placeholder="搜索服务 API Key"
									/>
									<div className="button-row" style={{ marginTop: 6 }}>
										<button type="button" onClick={saveWsKey} disabled={busy || !wsKey.trim()}>
											保存 Key
										</button>
										<button type="button" onClick={runWsTest} disabled={busy}>
											测试搜索
										</button>
									</div>
								</div>
							</div>

							<div className="setting">
								<div className="setting-label">
									返回条数
									<span className="hint">1–10</span>
								</div>
								<div className="setting-control">
									<input
										type="number"
										min={1}
										max={10}
										value={wsMax}
										onChange={(e) => setWsMax(Number(e.target.value) || 5)}
										onBlur={() => saveWebSearch({ maxResults: wsMax })}
									/>
								</div>
							</div>

							{wsTest && (
								<div className="ws-test">
									{wsTest.ok ? (
										<>
											<div className="hint">
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
															<span className="hint"> {r.url}</span>
														</li>
													))}
												</ul>
											) : (
												<pre className="ws-test-text">{(wsTest.text ?? "（无内容）").slice(0, 1200)}</pre>
											)}
										</>
									) : (
										<div className="config-errors">测试失败：{wsTest.error}</div>
									)}
								</div>
							)}
						</div>

						<div
							className="settings-section"
							ref={(el) => {
								sectionRefs.current.skills = el;
							}}
						>
							<h3>技能</h3>
							<p className="section-desc">
								导入 SKILL.md 技能并按书启用。技能说明由模型按需用 read_skill 读取；脚本执行默认每次都会弹窗确认具体命令。
							</p>

							<div className="setting">
								<div className="setting-label">
									允许执行技能脚本
									<span className="hint">关闭时模型看不到 run_skill_script</span>
								</div>
								<div className="setting-control">
									<label className="checkbox-line">
										<input
											type="checkbox"
											checked={executionEnabled}
											onChange={(e) => toggleExecution(e.target.checked)}
										/>
										允许执行（每次弹窗确认）
									</label>
									{runtime && (
										<span className="hint">
											Python：{runtime.python ?? "未检测到"} · Node：{runtime.node}
										</span>
									)}
								</div>
							</div>

							<div className="button-row" style={{ margin: "12px 0" }}>
								<button type="button" className="primary" onClick={importSkill} disabled={busy}>
									导入技能（文件夹 / .md / .zip）
								</button>
							</div>

							{skills.diagnostics.length > 0 && (
								<div className="config-errors">已跳过：{skills.diagnostics.join("；")}</div>
							)}

							{skills.skills.length === 0 ? (
								<div className="hint">还没有导入任何技能。</div>
							) : (
								<>
									<div className="skill-list-head">
										已安装技能（左侧勾选 = 本书启用
										{executionEnabled ? "；右侧「免确认」= 执行时不再询问" : ""}）
									</div>
									<div className="skill-list">
										{skills.skills.map((s) => (
											<div key={s.name} className="skill-item">
												<label className="skill-item-main">
													<input
														type="checkbox"
														checked={enabledSkills.includes(s.name)}
														disabled={!docId}
														onChange={(e) => toggleSkill(s.name, e.target.checked)}
													/>
													<span className="skill-item-text">
														<span className="skill-name">{s.name}</span>
														<span className="skill-desc">{s.description}</span>
													</span>
												</label>
												<span className="skill-item-actions">
													<label className="checkbox-line" title="此后该技能执行脚本不再弹窗确认">
														<input
															type="checkbox"
															checked={trustedSkills.includes(s.name)}
															disabled={!executionEnabled}
															onChange={(e) => toggleTrust(s.name, e.target.checked)}
														/>
														免确认
													</label>
													<button type="button" onClick={() => removeSkill(s.name)}>
														删除
													</button>
												</span>
											</div>
										))}
									</div>
								</>
							)}
							{!docId && <div className="hint">打开一本书后，即可针对该书勾选启用的技能。</div>}
						</div>

						<div
							className="settings-section"
							ref={(el) => {
								sectionRefs.current.agent = el;
							}}
						>
							<h3>对话</h3>
							<p className="section-desc">
								控制每条消息最多经过多少轮工具调用（读页、检索、联网、技能等）。
							</p>
							<div className="setting">
								<div className="setting-label">
									最大工具回合数
									<span className="hint">1–20，默认 8</span>
								</div>
								<div className="setting-control">
									<input
										type="number"
										min={1}
										max={20}
										value={maxTurns}
										onChange={(e) => setMaxTurns(Number(e.target.value) || 8)}
										onBlur={() =>
											window.api.saveSettings({
												agentMaxTurns: String(Math.max(1, Math.min(20, maxTurns))),
											})
										}
									/>
								</div>
							</div>
						</div>

						<div
							className="settings-section"
							ref={(el) => {
								sectionRefs.current.reading = el;
							}}
						>
							<h3>阅读</h3>
							<div className="setting">
								<div className="setting-label">
									OCR 语言
									<span className="hint">Tesseract 语言包，如 chi_sim+eng / eng / jpn</span>
								</div>
								<div className="setting-control">
									<input
										value={ocrLang}
										onChange={(e) => setOcrLang(e.target.value)}
										placeholder="chi_sim+eng"
									/>
								</div>
							</div>
						</div>

						<div
							className="settings-section"
							ref={(el) => {
								sectionRefs.current.config = el;
							}}
						>
							<h3>配置文件</h3>
							<p className="section-desc">
								models.json 是 AI 友好配置，允许注释。手动添加的提供商在 custom-providers.json。
							</p>
							<div className="button-row" style={{ marginBottom: 8 }}>
								<button
									type="button"
									onClick={async () => {
										const c = await window.api.getAiConfig();
										setAi(c);
										setConfigText(c.text);
										setErrors(c.errors);
									}}
								>
									重新载入
								</button>
								<button type="button" onClick={() => window.api.openAiConfig()}>
									用系统编辑器打开
								</button>
								<button type="button" className="primary" onClick={saveConfig}>
									保存配置
								</button>
							</div>
							<div className="hint" style={{ marginBottom: 8 }}>
								{ai?.path}
							</div>
							{errors.length > 0 && (
								<ul className="config-errors">
									{errors.map((err) => (
										<li key={err}>{err}</li>
									))}
								</ul>
							)}
							<textarea
								className="config-text"
								value={configText}
								onChange={(e) => setConfigText(e.target.value)}
								spellCheck={false}
							/>
						</div>

						{note && <div className="settings-note">{note}</div>}
					</div>
				</div>

				<div className="modal-footer">
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
