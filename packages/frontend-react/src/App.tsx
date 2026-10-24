import { useCallback, useEffect, useRef, useState } from "react";
import "./App.css";
import { ConnectForm } from "./components/ConnectForm";
import { ReportView } from "./components/ReportView";
import { ScanView } from "./components/ScanView";
import { getJob, runDemo, startAudit, type Job } from "./lib/api";
import { buildHtmlReport, buildJsonReport, downloadBlob } from "./lib/report";

type View = "form" | "scan" | "report";

function App() {
	const [view, setView] = useState<View>("form");
	const [job, setJob] = useState<Job | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

	const stopPolling = () => {
		if (pollRef.current) {
			clearInterval(pollRef.current);
			pollRef.current = null;
		}
	};

	/** Poll the job until it finishes or errors. */
	const poll = useCallback(async (jobId: string) => {
		stopPolling();
		pollRef.current = setInterval(async () => {
			try {
				const j = await getJob(jobId);
				setJob(j);
				if (j.status === "done") {
					stopPolling();
					setView("report");
					window.scrollTo({ top: 0 });
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
			window.scrollTo({ top: 0 });
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	};

	const download = async (fmt: "json" | "html") => {
		if (!job) return;
		try {
			const j = await getJob(job.job_id);
			if (j.status !== "done" || !j.summary) {
				setError("Report not ready yet.");
				return;
			}
			const region = j.summary.region;
			const date = j.summary.date;
			if (fmt === "json") {
				downloadBlob(new Blob([buildJsonReport(j)], { type: "application/json" }), `cost-optimization-${region}-${date}.json`);
			} else {
				downloadBlob(new Blob([buildHtmlReport(j)], { type: "text/html" }), `cost-optimization-${region}-${date}.html`);
			}
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	};

	return (
		<>
			<header className="top">
				<div className="top-in">
					<a href="/" className="brand">
						<span className="mark">AWS</span> Cost Audit <em>read-only</em>
					</a>
				</div>
			</header>
			<main className="wrap">
				{view === "form" && <ConnectForm error={error} busy={busy} onRun={runAudit} onDemo={runSample} />}
				{view === "scan" && job && <ScanView job={job} />}
				{view === "report" && job?.summary && (
					<ReportView job={job} onNew={() => { setJob(null); setView("form"); }} onDownload={download} />
				)}
			</main>
			<footer className="foot">Keys live only in server memory for 30 min. No storage, no logs.</footer>
		</>
	);
}

// Auto-run demo when ?demo=1
export default App;
