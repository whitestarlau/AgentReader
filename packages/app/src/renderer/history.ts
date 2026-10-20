/**
 * 历史消息重建：把界面上的对话还原成模型可用的消息序列。
 *
 * 为什么需要重建：assistant 消息在界面上被压成 `content` + `timeline`（思考/工具），
 * 若只把 content 作为历史发出去，追问时模型就看不到上一轮工具读到的内容
 * （章节原文、检索结果等），只能重读或凭印象回答。这里把 timeline 还原成
 * `assistant(tool_calls) → tool(result)` 消息对 —— OpenAI 与 Anthropic 两条协议
 * 都接受这种形状（见 packages/ai 的适配器）。
 *
 * 两个上限避免历史无限膨胀：
 * - 单条工具结果截断到 TOOL_RESULT_MAX 字符；
 * - 历史中工具结果合计不超过 TOOL_RESULT_BUDGET 字符，超出时从最旧的工具轮次
 *   开始整轮丢弃（各轮的最终回答文本始终保留）。
 */

export type HistoryToolItem = {
	kind: "tool";
	id: string;
	name: string;
	args: string;
	result?: string;
	pending?: boolean;
};
export type HistoryReasoningItem = { kind: "reasoning"; content: string };
export type HistoryTimelineItem = HistoryToolItem | HistoryReasoningItem;

/** 界面消息（ChatPanel 的 Msg 与之结构兼容）。 */
export type HistorySource = {
	role: "user" | "assistant";
	content: string;
	timeline?: HistoryTimelineItem[];
};

export type HistoryMessage = {
	role: "user" | "assistant" | "tool";
	content: string;
	toolCalls?: { id: string; name: string; arguments: string }[];
	toolCallId?: string;
	toolName?: string;
};

/** 单条工具结果进入历史的长度上限（字符）。 */
const TOOL_RESULT_MAX = 4000;
/** 历史中所有工具结果的合计长度上限（字符），超出时丢弃最旧的轮次。 */
const TOOL_RESULT_BUDGET = 20000;

type ToolRound = {
	toolCalls: { id: string; name: string; arguments: string }[];
	results: { id: string; name: string; content: string }[];
};

function clipToolResult(text: string): string {
	return text.length > TOOL_RESULT_MAX
		? `${text.slice(0, TOOL_RESULT_MAX)}\n…（内容过长，已截断）`
		: text;
}

/**
 * 把一轮 assistant 的 timeline 拆成若干「模型轮次」。工具调用之后的思考属于
 * 下一次模型调用，因此遇到「已有工具调用的轮次后面又出现思考」就开新一轮。
 * 旧版落盘数据把多轮思考合并成一段（顺序为 思考…、工具…），拆出来仍是一个
 * 合法的轮次，只是工具按并列调用处理。
 */
function toRounds(items: readonly HistoryTimelineItem[] | undefined): ToolRound[] {
	const rounds: ToolRound[] = [];
	const last = () => rounds[rounds.length - 1];
	for (const it of items ?? []) {
		if (it.kind === "reasoning") {
			if (last()?.toolCalls.length) rounds.push({ toolCalls: [], results: [] });
			continue;
		}
		// 未完成的工具调用没有结果：整条跳过，避免出现「有调用无结果」的非法消息对。
		if (it.result === undefined) continue;
		if (!last()) rounds.push({ toolCalls: [], results: [] });
		last().toolCalls.push({ id: it.id, name: it.name, arguments: it.args });
		last().results.push({ id: it.id, name: it.name, content: clipToolResult(it.result) });
	}
	return rounds.filter((r) => r.toolCalls.length > 0);
}

/** 重建完整历史（含工具调用与结果）。 */
export function buildHistory(msgs: readonly HistorySource[]): HistoryMessage[] {
	const roundsByMsg = msgs.map((m) => (m.role === "assistant" ? toRounds(m.timeline) : []));

	// 预算从最新往旧分配，超出的整轮丢弃。
	let budget = TOOL_RESULT_BUDGET;
	for (let i = msgs.length - 1; i >= 0; i--) {
		for (let r = roundsByMsg[i].length - 1; r >= 0; r--) {
			const size = roundsByMsg[i][r].results.reduce((n, x) => n + x.content.length, 0);
			if (size > budget) roundsByMsg[i].splice(r, 1);
			else budget -= size;
		}
	}

	const out: HistoryMessage[] = [];
	msgs.forEach((m, i) => {
		if (m.role === "user") {
			out.push({ role: "user", content: m.content });
			return;
		}
		for (const round of roundsByMsg[i]) {
			out.push({ role: "assistant", content: "", toolCalls: round.toolCalls });
			for (const res of round.results) {
				out.push({ role: "tool", content: res.content, toolCallId: res.id, toolName: res.name });
			}
		}
		// 本轮最终回答（含被丢弃工具轮次时，回答文本仍然保留）。
		if (m.content) out.push({ role: "assistant", content: m.content });
	});
	return out;
}
