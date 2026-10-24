interface JobLike {
	status: string;
	progress: number;
	logs: string[];
	error?: string;
}

export function ScanView({ job }: { job: JobLike }) {
	return (
		<section className="card">
			<div className="scan-head">
				<h1>Scanning…</h1>
				<span className="pct">{job.progress}%</span>
			</div>
			<div className="progress">
				<div className="fill" style={{ width: `${job.progress}%` }} />
			</div>
			<pre className="log">{(job.logs ?? []).join("\n") || "Working…"}</pre>
			{job.error && <p className="errmsg">{job.error}</p>}
		</section>
	);
}
