/**
 * 更新链路的统一错误。
 *
 * 每个错误都带一个稳定的 `code`（渲染层据此决定提示文案）和一句 `hint`
 * （告诉用户下一步能做什么）。网络、限流、校验失败的区别必须能穿透 IPC，
 * 否则用户只会看到一句「更新失败」。
 */

export type UpdateErrorCode =
	| "network"
	| "timeout"
	| "cancelled"
	| "not-found"
	| "rate-limited"
	| "unauthorized"
	| "server"
	| "bad-response"
	| "no-release"
	| "no-asset"
	| "checksum"
	| "incomplete"
	| "permission"
	| "install"
	| "internal";

export class UpdateError extends Error {
	readonly code: UpdateErrorCode;
	readonly hint?: string;

	constructor(code: UpdateErrorCode, message: string, opts?: { hint?: string; cause?: unknown }) {
		super(message, opts?.cause === undefined ? undefined : { cause: opts.cause });
		this.name = "UpdateError";
		this.code = code;
		this.hint = opts?.hint;
	}
}

export function messageOf(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

/** 把任意异常收敛成 UpdateError，避免 IPC 里漏出裸 Error。 */
export function toUpdateError(error: unknown): UpdateError {
	if (error instanceof UpdateError) return error;
	return new UpdateError("internal", messageOf(error), { cause: error });
}
