import { useCallback, useEffect, useRef, useState } from "react";
import "./App.css";
import { ConnectForm } from "./components/ConnectForm";
import { FindingsSection } from "./components/FindingsSection";
import { JobInfoSection } from "./components/JobInfoSection";
import { OverviewSection } from "./components/OverviewSection";
import { RecommendationsSection } from "./components/RecommendationsSection";
import { SavingsByService } from "./components/SavingsByService";
import { ScanView } from "./components/ScanView";
import { Sidebar } from "./components/Sidebar";
import { apiUrl, getJob, runDemo, startAudit, type Job } from "./lib/api";
import { computeMetrics } from "./lib/metrics";
import { buildHtmlReport, buildJsonReport, downloadBlob } from "./lib/report";

type View = "form" | "scan" | "report";

function App() {
	const [view, setView] = useState<View>("form");
	const [job, setJob] = useState<Job | null>(null);
	const [active, setActive] = useState("overview");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const mainRef = useRef<HTMLElement>(null);
	const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

	const stopPolling = () => {
		if (pollRef.current) {
			clearInterval(pollRef.current);
			pollRef.current = null;
		}
	};

	const poll = useCallback(async (jobId: string) => {
		stopPolling();
		pollRef.current = setInterval(async () => {
			try {
				const j = await getJob(jobId);
				setJob(j);
				if (j.status === "done") {
					stopPolling();
					setView("report");
					mainRef.current?.scrollTo({ top: 0 });
				} else if (j.status === "error") {
					stopPolling();
					setError(j.error ?? "Audit failed");
					setView("form");
				}
			} catch {
				/* transient network errors — keep polling */
			}
		}, 2000);
	}, []);

	useEffect(() => () => stopPolling(), []);

	const runAudit = async (creds: { access_key_id: string; secret_access_key: string; session_token: string; region: string }) => {
		setError(null);
		setBusy(true);
		try {
			const { job_id } = await startAudit({ ...creds, days: 14 });
			setView("scan");
			setJob({ job_id, status: "running", progress: 0, logs: [] });
			await poll(job_id);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	};

	const runSample = async () => {
		setError(null);
		setBusy(true);
		try {
			const { job_id } = await runDemo();
			const j = await getJob(job_id);
			setJob(j);
			setView("report");
			mainRef.current?.scrollTo({ top: 0 });
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	};

	const download = async (fmt: "json" | "html" | "docx") => {
		if (!job) return;
		try {
			let filename: string;
			let blob: Blob;
			if (fmt === "docx") {
				// DOCX is generated server-side (proper Word structure, per-service tables).
				const res = await fetch(apiUrl(`/api/download/${job.job_id}?format=docx`));
				if (!res.ok) throw new Error(`DOCX download failed (${res.status})`);
				blob = await res.blob();
				filename = `cost-optimization-${job.summary!.region}-${job.summary!.date}.docx`;
			} else {
				const j = await getJob(job.job_id);
				if (j.status !== "done" || !j.summary) {
					setError("Report not ready yet.");
					return;
				}
				filename = `cost-optimization-${j.summary.region}-${j.summary.date}.${fmt}`;
				blob = fmt === "json"
					? new Blob([buildJsonReport(j)], { type: "application/json" })
					: new Blob([buildHtmlReport(j)], { type: "text/html" });
			}
			downloadBlob(blob, filename);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	};

	const nav = (id: string) => {
		setActive(id);
		document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
	};

	const m = job && view === "report" && job.summary ? computeMetrics(job) : null;

	return (
		<div className="app">
			<Sidebar
				onNav={nav}
				active={active}
				loaded={view === "report"}
				jobId={job?.job_id ?? null}
				date={job?.summary?.date ?? null}
			/>

			<main className="main" ref={mainRef}>
				<div className="main-in">
					{view === "form" && (
						<ConnectForm error={error} busy={busy} onRun={runAudit} onDemo={runSample} />
					)}
					{view === "scan" && job && <ScanView job={job} />}

					{view === "report" && job?.summary && job.payload && m && (
						<>
							<div className="rep-head">
								<h1>Cost Optimization Report</h1>
								<div className="dl">
									<button className="btn" onClick={() => download("json")}>JSON</button>
									<button className="btn" onClick={() => download("html")}>HTML</button>
									<button className="btn" onClick={() => download("docx")}>DOCX</button>
									<button className="btn" onClick={() => { setJob(null); setView("form"); }}>← New audit</button>
								</div>
							</div>
							<OverviewSection job={job} m={m} />
							<SavingsByService m={m} total={m.estMonthly} />
							<FindingsSection m={m} total={m.estMonthly} />
							<RecommendationsSection m={m} />
							<JobInfoSection job={job} m={m} />
						</>
					)}
				</div>
			</main>
		</div>
	);
}

export default App;
