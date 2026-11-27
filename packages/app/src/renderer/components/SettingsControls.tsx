import type { ReactNode } from "react";

/**
 * 设置页的三件基础控件：卡片、标签行、开关。
 *
 * 单独成文件是为了让 `UpdateSection` 这类分区组件复用同一套排版，
 * 而不必反过来 import 整个 `Settings`（会形成循环依赖）。
 */

/** A bordered group of related settings. */
export function Card({
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
export function Field({
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

export function Switch({
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
