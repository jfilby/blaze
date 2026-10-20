/*
 * Blaze Pulse: the dashboard.
 *
 * The numbers come from the event stream the server publishes: every snapshot
 * carries the counters the server keeps and the latency it measured. The rate
 * is computed here, because the rate is a question about two readings and the
 * time between them, and the time between them is the browser's to know.
 */

"use strict";

/** How many readings the rate and the chart are computed of. */
const HISTORY = 120;

/** The readings: the counter and the time it was read at. */
const history = [];

/** The elements the numbers are written into. */
const fields = {
	served: document.getElementById("served"),
	rate: document.getElementById("rate"),
	p50: document.getElementById("p50"),
	p95: document.getElementById("p95"),
	p99: document.getElementById("p99"),
	mean: document.getElementById("mean"),
	max: document.getElementById("max"),
	failed: document.getElementById("failed"),
	bytes: document.getElementById("bytes"),
	window: document.getElementById("window"),
	windowServed: document.getElementById("windowServed"),
	elapsed: document.getElementById("elapsed"),
	streams: document.getElementById("streams"),
	status: document.getElementById("status"),
	reportTool: document.getElementById("reportTool"),
	reportTotal: document.getElementById("reportTotal"),
	reportRps: document.getElementById("reportRps"),
	reportLatency: document.getElementById("reportLatency"),
	reportMean: document.getElementById("reportMean"),
	reportErrors: document.getElementById("reportErrors"),
	reportDuration: document.getElementById("reportDuration"),
	report: document.getElementById("report"),
	line: document.getElementById("line"),
	area: document.getElementById("area"),
	peak: document.getElementById("peak"),
	grid: document.getElementById("grid"),
};

/** A number with the thousands of it separated. */
function grouped(value) {
	return Math.round(value).toLocaleString("en-US");
}

/** The rate, in requests per second, over the readings that are held. */
function rate() {
	if (history.length < 2) {
		return 0;
	}
	const first = history[0];
	const last = history[history.length - 1];
	const seconds = (last.at - first.at) / 1000;
	if (seconds <= 0) {
		return 0;
	}
	return (last.served - first.served) / seconds;
}

/** The chart, drawn from the readings that are held. */
function draw() {
	const width = 960;
	const height = 220;
	const rates = [];
	for (let at = 1; at < history.length; at += 1) {
		const previous = history[at - 1];
		const current = history[at];
		const seconds = (current.at - previous.at) / 1000;
		rates.push(seconds > 0 ? (current.served - previous.served) / seconds : 0);
	}
	let peak = 0;
	for (const value of rates) {
		if (value > peak) {
			peak = value;
		}
	}
	const scale = peak > 0 ? peak : 1;
	const points = [];
	rates.forEach((value, index) => {
		const x = rates.length > 1 ? (index / (rates.length - 1)) * width : width;
		const y = height - (value / scale) * (height - 20) - 10;
		points.push(`${x.toFixed(1)},${y.toFixed(1)}`);
	});
	const line = points.length > 0 ? `M ${points.join(" L ")}` : "";
	fields.line.setAttribute("d", line);
	fields.area.setAttribute(
		"d",
		points.length > 0 ? `${line} L ${width},${height} L 0,${height} Z` : "",
	);
	fields.peak.textContent = `${Math.round(peak)} req/s peak`;
	let grid = "";
	for (let at = 1; at < 4; at += 1) {
		const y = (height / 4) * at;
		grid += `<line x1="0" y1="${y}" x2="${width}" y2="${y}" />`;
	}
	fields.grid.innerHTML = grid;
}

/** What a snapshot says, written into the dashboard. */
function show(snapshot) {
	history.push({ at: Date.now(), served: snapshot.served });
	while (history.length > HISTORY) {
		history.shift();
	}
	fields.served.textContent = grouped(snapshot.served);
	fields.rate.textContent = `${grouped(rate())} req/s`;
	fields.p50.textContent = grouped(snapshot.p50Us);
	fields.p95.textContent = grouped(snapshot.p95Us);
	fields.p99.textContent = grouped(snapshot.p99Us);
	fields.mean.textContent = snapshot.meanMs.toFixed(3);
	fields.max.textContent = snapshot.maxMs.toFixed(3);
	fields.failed.textContent = grouped(snapshot.failed);
	fields.bytes.textContent = grouped(snapshot.bytes);
	fields.window.textContent = snapshot.running > 0 ? "running" : "idle";
	fields.windowServed.textContent = grouped(snapshot.windowServed);
	fields.elapsed.textContent = `${Math.round(snapshot.elapsedMs)} ms`;
	fields.streams.textContent = grouped(snapshot.streams);
	if (snapshot.reportTotal > 0) {
		fields.report.hidden = false;
		fields.reportTool.textContent = "oha or wrk";
		fields.reportTotal.textContent = grouped(snapshot.reportTotal);
		fields.reportRps.textContent = `${grouped(snapshot.reportRps)} req/s`;
		fields.reportLatency.textContent = `${snapshot.reportP50} / ${snapshot.reportP95} / ${snapshot.reportP99} ms`;
		fields.reportMean.textContent = `${snapshot.reportMean} ms`;
		fields.reportErrors.textContent = grouped(snapshot.reportErrors);
		fields.reportDuration.textContent = `${grouped(snapshot.reportDurationMs)} ms`;
	}
	draw();
}

/** The stream of snapshots the server publishes. */
function listen() {
	const stream = new EventSource("/events");
	stream.addEventListener("open", () => {
		fields.status.textContent = "live";
		fields.status.classList.add("live");
	});
	stream.addEventListener("message", (event) => {
		try {
			show(JSON.parse(event.data));
		} catch (error) {
			fields.status.textContent = "a snapshot could not be read";
		}
	});
	stream.addEventListener("error", () => {
		fields.status.textContent = "reconnecting…";
		fields.status.classList.remove("live");
	});
}

/*
 * The heartbeat: the dashboard asks the server for a snapshot now and then,
 * so that the stream carries numbers even while the server has nothing to do.
 * It is the dashboard's own traffic and the server does not count it.
 */
function heartbeat() {
	window.setInterval(() => {
		window.fetch("/api/heartbeat").catch(() => {
			fields.status.textContent = "the server is not answering";
		});
	}, 1000);
}

listen();
heartbeat();
