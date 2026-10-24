// Sidebar navigation — no data imports needed.

interface Props {
	onNav: (id: string) => void;
	active: string;
	loaded: boolean;
	jobId: string | null;
	date: string | null;
}

const NAV = [
	{ id: "overview", label: "Overview" },
	{ id: "savings", label: "Savings by Service" },
	{ id: "findings", label: "Findings" },
	{ id: "recommendations", label: "Recommendations" },
	{ id: "jobinfo", label: "Audit Info" },
];

export function Sidebar({ onNav, active, loaded, jobId, date }: Props) {
	return (
		<aside className="sidebar">
			<a href="/" className="brand">
				<span className="mark">AWS</span> Cost Audit
				<em>read-only</em>
			</a>

			<nav className="side-nav">
				{NAV.map((n) => (
					<button
						key={n.id}
						className={`nav-item${active === n.id ? " on" : ""}`}
						disabled={!loaded}
						onClick={() => onNav(n.id)}
					>
						{n.label}
					</button>
				))}
			</nav>

			<div className="side-foot">
				{jobId && (
					<>
						<p>Job <code>{jobId}</code></p>
						{date && <p>{date}</p>}
					</>
				)}
				<p className="dim">Keys live only in server memory for 30 min.</p>
			</div>
		</aside>
	);
}
