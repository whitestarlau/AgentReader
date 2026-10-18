/** 平台判断与快捷键标签（渲染层）。 */
export const IS_MAC =
	typeof navigator !== "undefined" &&
	/Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent);

/** 命令键标签：macOS 显示 ⌘，Windows/Linux 显示 Ctrl（如 ⌘B / Ctrl+B）。 */
export const MOD_KEY = IS_MAC ? "⌘" : "Ctrl";

/** 框选修饰键标签：macOS 是 ⌥，其它平台是 Alt。 */
export const ALT_KEY = IS_MAC ? "⌥" : "Alt";
