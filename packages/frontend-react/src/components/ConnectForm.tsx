import { useState } from "react";

interface Props {
	error: string | null;
	busy: boolean;
	onRun: (creds: { access_key_id: string; secret_access_key: string; session_token: string; region: string }) => void;
	onDemo: () => void;
}

/** Region dropdown options (common audit regions). */
const REGIONS = [
	"ap-south-1",
	"us-east-1",
	"us-east-2",
	"us-west-1",
	"us-west-2",
	"eu-west-1",
	"eu-west-2",
	"eu-central-1",
	"ap-southeast-1",
	"ap-southeast-2",
	"ap-northeast-1",
	"sa-east-1",
];

export function ConnectForm({ error, busy, onRun, onDemo }: Props) {
	const [ak, setAk] = useState("");
	const [sk, setSk] = useState("");
	const [st, setSt] = useState("");
	const [region, setRegion] = useState("ap-south-1");

	const submit = (e: React.FormEvent) => {
		e.preventDefault();
		if (!ak.trim() || !sk.trim()) return;
		onRun({ access_key_id: ak.trim(), secret_access_key: sk.trim(), session_token: st.trim(), region });
		setSk("");
		setSt("");
	};

	return (
		<section className="card">
			<h1>Run audit</h1>
			{!busy && (
				<button type="button" className="btn demo" onClick={onDemo} disabled={busy}>
					Run sample audit (demo)
				</button>
			)}
			<p>Enter read-only AWS credentials. Keys are never persisted — the backend holds them for 30 min max.</p>
			<form onSubmit={submit}>
				<input value={ak} onChange={(e) => setAk(e.target.value)} placeholder="Access Key ID  (AKIA…)" required autoComplete="off" />
				<input type="password" value={sk} onChange={(e) => setSk(e.target.value)} placeholder="Secret Access Key" required autoComplete="new-password" />
				<input type="password" value={st} onChange={(e) => setSt(e.target.value)} placeholder="Session Token (optional, for STS roles)" autoComplete="new-password" />
				<div className="row">
					<select value={region} onChange={(e) => setRegion(e.target.value)}>
						{REGIONS.map((r) => (
							<option key={r} value={r}>
								{r}
							</option>
						))}
					</select>
					<span className="days">lookback: 14d</span>
					<button className="btn primary" disabled={busy || !ak.trim() || !sk.trim()}>
						{busy ? "Starting…" : "Run audit →"}
					</button>
				</div>
			</form>
			{error && <p className="errmsg">{error}</p>}
		</section>
	);
}
