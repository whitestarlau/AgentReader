import type { ReactNode, SVGProps } from "react";

type IconName =
	| "library"
	| "search"
	| "annotations"
	| "chat"
	| "settings"
	| "close"
	| "plus"
	| "chevronRight"
	| "chevronDown"
	| "chevronLeft"
	| "sidebarLeft"
	| "sidebarRight"
	| "trash"
	| "send"
	| "sparkle"
	| "file"
	| "book"
	| "panel"
	| "tool"
	| "check"
	| "edit"
	| "stop";

const PATHS: Record<IconName, ReactNode> = {
	library: (
		<>
			<path d="M2.6 2.6h3.6a2 2 0 0 1 1.8 1.1 2 2 0 0 1 1.8-1.1h3.6v10.2h-3.6a2 2 0 0 0-1.8 1.1 2 2 0 0 0-1.8-1.1H2.6z" />
			<path d="M8 3.7v9.9" />
		</>
	),
	search: (
		<>
			<circle cx="7" cy="7" r="4.2" />
			<path d="M10.2 10.2 14 14" />
		</>
	),
	annotations: <path d="M3.2 2.4h9.6v11.2L8 10.6l-4.8 3z" />,
	chat: <path d="M2.4 3.4h11.2v7.2H7.2L3.4 13.6l.6-3H2.4z" />,
	settings: (
		<>
			<circle cx="8" cy="8" r="2.4" />
			<path d="M8 1.8v1.4M8 12.8v1.4M1.8 8h1.4M12.8 8h1.4M3.6 3.6l1 1M11.4 11.4l1 1M12.4 3.6l-1 1M4.6 11.4l-1 1" />
		</>
	),
	close: <path d="M4 4l8 8M12 4l-8 8" />,
	plus: <path d="M8 3.2v9.6M3.2 8h9.6" />,
	chevronRight: <path d="M6 3.5 10.5 8 6 12.5" />,
	chevronDown: <path d="M3.5 6 8 10.5 12.5 6" />,
	chevronLeft: <path d="M10 3.5 5.5 8 10 12.5" />,
	sidebarLeft: (
		<>
			<rect x="1.6" y="2.4" width="12.8" height="11.2" rx="1.4" />
			<path d="M6 2.4v11.2" />
		</>
	),
	sidebarRight: (
		<>
			<rect x="1.6" y="2.4" width="12.8" height="11.2" rx="1.4" />
			<path d="M10 2.4v11.2" />
		</>
	),
	trash: <path d="M2.6 4h10.8M6 4V2.4h4V4M3.8 4l.7 9.6h7l.7-9.6" />,
	send: (
		<>
			<path d="M14 2 2 7.2l4.7 1.8L9 14z" />
			<path d="M14 2 6.7 9" />
		</>
	),
	sparkle: <path d="M8 1.4 9.4 6 14 7.4 9.4 8.8 8 13.4 6.6 8.8 2 7.4 6.6 6z" />,
	file: (
		<>
			<path d="M4 1.6h5l3 3v9.8H4z" />
			<path d="M9 1.6v3h3" />
		</>
	),
	book: (
		<>
			<path d="M2.6 3.2a2.4 2.4 0 0 1 2.4-1.6h3v10.8h-3a2.4 2.4 0 0 0-2.4 1.6z" />
			<path d="M13.4 3.2a2.4 2.4 0 0 0-2.4-1.6h-3v10.8h3a2.4 2.4 0 0 1 2.4 1.6z" />
		</>
	),
	panel: (
		<>
			<rect x="1.6" y="2.4" width="12.8" height="11.2" rx="1.4" />
			<path d="M1.6 9.2h12.8" />
		</>
	),
	check: <path d="M3 8.4 6.4 11.6 13 4.4" />,
	edit: (
		<>
			<path d="M9.6 2.6 13.4 6.4 6.2 13.6H2.4v-3.8z" />
			<path d="M8.4 3.8 12.2 7.6" />
		</>
	),
	stop: <rect x="3.6" y="3.6" width="8.8" height="8.8" rx="1.2" />,
	tool: (
		<>
			<path d="M10.6 1.6a3.6 3.6 0 0 0-3 5.5L1.8 12.9l1.3 1.3 5.8-5.8a3.6 3.6 0 0 0 4.9-4.6l-2.1 2.1-1.7-1.7 2.1-2.1a3.6 3.6 0 0 0-1.5-.5z" />
		</>
	),
};

export function Icon({
	name,
	size = 16,
	strokeWidth = 1.2,
	...rest
}: { name: IconName; size?: number; strokeWidth?: number } & SVGProps<SVGSVGElement>) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 16 16"
			fill="none"
			stroke="currentColor"
			strokeWidth={strokeWidth}
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
			{...rest}
		>
			{PATHS[name]}
		</svg>
	);
}
