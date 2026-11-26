/**
 * 「哪里改了」的中枢。
 *
 * 所有会改变同步数据的写盘动作只调用这里（`markSettingsDirty` / `markDocDirty`），
 * 具体什么时候真同步由同步引擎去抖决定。
 *
 * 刻意零依赖（不 import electron、不 import fs）：
 * - `settings.ts` / `ai-config.ts` 可以安全地反向依赖它，不会形成环；
 * - 单测可以直接断言「标脏 → 收到通知 → 消费后只清掉本次处理过的部分」。
 *
 * 内部用**代际计数**而不是布尔量：同步过程中用户可能又改了设置，如果消费时一把清空，
 * 这次新改动就被吞掉，只能等下一次写盘才会被发现。记住「我消费到第几代」才只清该清的。
 *
 * 计划 §4.0 的写盘审计表就是这张网的验收清单：漏接一处，对应字段就永不触发同步。
 */

export type DirtyListener = () => void;

/** 一次消费的快照：设置与各文档各自的代际，`clearPending` 据此精确清账。 */
export type DirtySnapshot = {
	settings: boolean;
	settingsGen: number;
	docs: string[];
	docGens: Array<[string, number]>;
};

const listeners = new Set<DirtyListener>();

let settingsGen = 0;
let settingsAcked = 0;
let docClock = 0;
const docs = new Map<string, number>();

/** 订阅变更；返回取消订阅函数（不受控的监听会让退出时的定时器泄漏）。 */
export function onDirty(listener: DirtyListener): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

function emit(): void {
	for (const listener of [...listeners]) listener();
}

export function markSettingsDirty(): void {
	settingsGen += 1;
	emit();
}

export function markDocDirty(docId: string): void {
	if (!docId) return;
	docClock += 1;
	docs.set(docId, docClock);
	emit();
}

export function takePending(): DirtySnapshot {
	return {
		settings: settingsGen > settingsAcked,
		settingsGen,
		docs: [...docs.keys()],
		docGens: [...docs.entries()],
	};
}

/** 只清掉「本次已经处理过」的那部分；期间新产生的改动（更新的代际）保持待处理。 */
export function clearPending(snapshot: DirtySnapshot): void {
	settingsAcked = Math.max(settingsAcked, snapshot.settingsGen);
	for (const [docId, gen] of snapshot.docGens) {
		if (docs.get(docId) === gen) docs.delete(docId);
	}
}

/** 仅测试用：把中枢恢复到初始状态，避免用例之间互相污染。 */
export function resetDirtyState(): void {
	settingsGen = 0;
	settingsAcked = 0;
	docClock = 0;
	docs.clear();
	listeners.clear();
}
