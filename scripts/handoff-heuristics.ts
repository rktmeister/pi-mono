#!/usr/bin/env npx tsx
import { readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { spawn } from "child_process";
import { createInterface } from "readline";
import { homedir } from "os";
import { join, resolve } from "path";
import chalk from "chalk";
import {
	parseSessionEntries,
	type CustomEntry,
	type SessionEntry,
	type SessionHeader,
	type SessionMessageEntry,
} from "../packages/coding-agent/src/core/session-manager.js";

type GoalSource = "auto" | "handoff" | "last-user" | "first-user" | "summary-goal";

type GoalInfo = {
	goal: string;
	source: GoalSource;
	leafEntryId?: string;
};

type ToolCallInfo = {
	name: string;
	path?: string;
	command?: string;
};

type ToolResultInfo = {
	toolName: string;
	isError: boolean;
	contentText: string;
};

type Turn = {
	index: number;
	startEntryId: string;
	entryIds: string[];
	userText: string;
	assistantText: string;
	toolCalls: ToolCallInfo[];
	toolResults: ToolResultInfo[];
	filePaths: Set<string>;
	hasError: boolean;
	highSignal: boolean;
	searchText: string;
	goalScore: number;
};

type TurnRecord = {
	sessionFile: string;
	sessionId: string;
	goalSource: GoalSource;
	goal: string;
	turnIndex: number;
	entryId: string;
	userText: string;
	assistantText: string;
	toolCalls: string[];
	toolErrors: string[];
	filePaths: string[];
	hasError: boolean;
	highSignal: boolean;
	goalScore: number;
	selected: boolean;
	required: boolean;
	reasons: string[];
};

type SessionSummary = {
	sessionFile: string;
	sessionId: string;
	goalSource: GoalSource;
	goal: string;
	turnCount: number;
	selectedCount: number;
};

type SelectionResult = {
	selected: boolean;
	required: boolean;
	reasons: string[];
};

type BudgetConfig = {
	anchorTokens: number;
	requiredAnchorTokens: number;
	optionalAnchorTokens: number;
	recentTurnCount: number;
	maxToolOutputLines: number;
};

type JsonEvent = {
	type: string;
	assistantMessageEvent?: { type: string; delta?: string };
	toolName?: string;
	args?: {
		path?: string;
		offset?: number;
		limit?: number;
		content?: string;
	};
};

const DEFAULT_BUDGETS: BudgetConfig = {
	anchorTokens: 2600,
	requiredAnchorTokens: 220,
	optionalAnchorTokens: 260,
	recentTurnCount: 2,
	maxToolOutputLines: 8,
};

const HIGH_SIGNAL_MARKERS = [
	"must",
	"constraint",
	"decision",
	"blocked",
	"todo",
	"fix",
	"should",
	"require",
	"avoid",
	"risk",
	"bug",
	"prefer",
];

const REDACTION_RULES: Array<{ pattern: RegExp; replacement: string }> = [
	{ pattern: /(API_KEY\s*[:=]\s*)(\S+)/gi, replacement: "$1[REDACTED]" },
	{ pattern: /(TOKEN\s*[:=]\s*)(\S+)/gi, replacement: "$1[REDACTED]" },
	{ pattern: /(SECRET\s*[:=]\s*)(\S+)/gi, replacement: "$1[REDACTED]" },
	{ pattern: /(PASSWORD\s*[:=]\s*)(\S+)/gi, replacement: "$1[REDACTED]" },
	{ pattern: /(BEARER\s+)([A-Za-z0-9\-._~+/]+=*)/gi, replacement: "$1[REDACTED]" },
	{ pattern: /(AKIA[0-9A-Z]{16})/g, replacement: "[REDACTED]" },
	{
		pattern: /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g,
		replacement: "[REDACTED PRIVATE KEY]",
	},
];

const SENSITIVE_PATH_PATTERNS = [
	/\.env(\.|$)/i,
	/auth\.json$/i,
	/\bid_rsa$/i,
	/\bid_ed25519$/i,
	/\.pem$/i,
	/\.key$/i,
	/\.p12$/i,
	/credentials/i,
];

const DEFAULT_OUTPUT_DIR = resolve("./handoff-heuristics");
const DEFAULT_TOP_K = 8;
const MAX_SNIPPET_CHARS = 700;
const MAX_DISPLAY_WIDTH = 100;

function cwdToSessionDir(cwd: string): string {
	const normalized = resolve(cwd).replace(/\//g, "-");
	return `--${normalized.slice(1)}--`;
}

function truncateLine(text: string, maxWidth: number): string {
	const singleLine = text.replace(/\n/g, " ").replace(/\s+/g, " ").trim();
	if (singleLine.length <= maxWidth) return singleLine;
	return singleLine.slice(0, maxWidth - 3) + "...";
}

function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

function truncateLines(text: string, maxLines: number): string {
	if (!text) return "";
	const lines = text.split("\n");
	if (lines.length <= maxLines) return text;
	return `${lines.slice(0, maxLines).join("\n")}\n...[${lines.length - maxLines} more lines truncated]`;
}

function truncateInline(text: string, maxLength: number): string {
	if (text.length <= maxLength) return text;
	return `${text.slice(0, maxLength)}...`;
}

function truncateToChars(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}...`;
}

function redactSensitiveText(text: string): string {
	let redacted = text;
	for (const rule of REDACTION_RULES) {
		redacted = redacted.replace(rule.pattern, rule.replacement);
	}
	return redacted;
}

function isSensitivePath(path: string): boolean {
	return SENSITIVE_PATH_PATTERNS.some((pattern) => pattern.test(path));
}

function normalizeText(text: string): string {
	return redactSensitiveText(text.trim());
}

function extractTextContent(content: string | Array<{ type: string; text?: string }>): string {
	if (typeof content === "string") return content;
	return content
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text ?? "")
		.join("");
}

function buildBranch(entries: SessionEntry[], leafEntryId?: string): SessionEntry[] {
	const byId = new Map<string, SessionEntry>();
	for (const entry of entries) {
		byId.set(entry.id, entry);
	}
	const leaf = leafEntryId ? byId.get(leafEntryId) : entries[entries.length - 1];
	if (!leaf) return [];
	const path: SessionEntry[] = [];
	let current: SessionEntry | undefined = leaf;
	while (current) {
		path.unshift(current);
		current = current.parentId ? byId.get(current.parentId) : undefined;
	}
	return path;
}

function findLatestHandoffGoal(entries: SessionEntry[]): { goal: string; entryId: string; timestamp?: string } | null {
	for (let i = entries.length - 1; i >= 0; i -= 1) {
		const entry = entries[i];
		if (entry.type !== "custom") continue;
		const custom = entry as CustomEntry;
		if (custom.customType !== "handoff" || !custom.data || typeof custom.data !== "object") continue;
		const data = custom.data as { goal?: unknown; timestamp?: unknown };
		if (typeof data.goal !== "string" || !data.goal.trim()) continue;
		return { goal: data.goal.trim(), entryId: entry.id, timestamp: typeof data.timestamp === "string" ? data.timestamp : undefined };
	}
	return null;
}

function extractGoalFromSummary(summary: string): string | null {
	const match = summary.match(/## Goal\s*\n([^\n]+)/i);
	if (!match || !match[1]) return null;
	return match[1].trim();
}

function findSummaryGoal(branch: SessionEntry[]): string | null {
	for (let i = branch.length - 1; i >= 0; i -= 1) {
		const entry = branch[i];
		if (entry.type !== "compaction" && entry.type !== "branch_summary") continue;
		const summary = "summary" in entry ? entry.summary : "";
		if (!summary) continue;
		const goal = extractGoalFromSummary(summary);
		if (goal) return goal;
	}
	return null;
}

function findLastUserGoal(branch: SessionEntry[]): string | null {
	for (let i = branch.length - 1; i >= 0; i -= 1) {
		const entry = branch[i];
		if (entry.type !== "message") continue;
		const msgEntry = entry as SessionMessageEntry;
		if (msgEntry.message.role !== "user") continue;
		const text = normalizeText(extractTextContent(msgEntry.message.content as string | Array<{ type: string; text?: string }>));
		if (text) return text;
	}
	return null;
}

function findFirstUserGoal(branch: SessionEntry[]): string | null {
	for (const entry of branch) {
		if (entry.type !== "message") continue;
		const msgEntry = entry as SessionMessageEntry;
		if (msgEntry.message.role !== "user") continue;
		const text = normalizeText(extractTextContent(msgEntry.message.content as string | Array<{ type: string; text?: string }>));
		if (text) return text;
	}
	return null;
}

function resolveGoal(entries: SessionEntry[], goalSource: GoalSource): GoalInfo | null {
	const handoff = findLatestHandoffGoal(entries);
	const fullBranch = buildBranch(entries);
	const summaryGoal = findSummaryGoal(fullBranch);
	const lastUser = findLastUserGoal(fullBranch);
	const firstUser = findFirstUserGoal(fullBranch);

	if (goalSource === "handoff") {
		if (!handoff) return null;
		return { goal: handoff.goal, source: "handoff", leafEntryId: handoff.entryId };
	}
	if (goalSource === "summary-goal") {
		if (!summaryGoal) return null;
		return { goal: summaryGoal, source: "summary-goal" };
	}
	if (goalSource === "first-user") {
		if (!firstUser) return null;
		return { goal: firstUser, source: "first-user" };
	}
	if (goalSource === "last-user") {
		if (!lastUser) return null;
		return { goal: lastUser, source: "last-user" };
	}

	if (handoff) return { goal: handoff.goal, source: "handoff", leafEntryId: handoff.entryId };
	if (summaryGoal) return { goal: summaryGoal, source: "summary-goal" };
	if (lastUser) return { goal: lastUser, source: "last-user" };
	if (firstUser) return { goal: firstUser, source: "first-user" };
	return null;
}

function deriveGoalTokens(goal: string): string[] {
	return goal
		.toLowerCase()
		.split(/[^a-z0-9_./-]+/)
		.filter((token) => token.length >= 3);
}

function formatToolCallDisplay(toolCall: ToolCallInfo): string {
	const safeCommand = toolCall.command ? redactSensitiveText(toolCall.command) : undefined;
	const safePath = toolCall.path && !isSensitivePath(toolCall.path) ? toolCall.path : toolCall.path ? "[redacted]" : undefined;
	if (toolCall.name === "bash" && safeCommand) {
		return `bash(command=${JSON.stringify(truncateInline(safeCommand, 180))})`;
	}
	if (safePath) {
		return `${toolCall.name}(path=${JSON.stringify(safePath)})`;
	}
	return toolCall.name;
}

function buildTurnExcerpt(turn: Turn, maxTokens: number): string {
	const lines: string[] = [];
	if (turn.userText) lines.push(`[User]: ${turn.userText}`);
	if (turn.assistantText) lines.push(`[Assistant]: ${turn.assistantText}`);
	if (turn.toolCalls.length > 0) {
		const callText = turn.toolCalls.map(formatToolCallDisplay).join("; ");
		lines.push(`[Assistant tool calls]: ${callText}`);
	}
	const errorResults = turn.toolResults.filter((result) => result.isError);
	if (errorResults.length > 0) {
		const snippets = errorResults.map((result) => `${result.toolName}: ${result.contentText}`).join("\n");
		lines.push(`[Tool errors]: ${snippets}`);
	}
	return truncateToChars(lines.join("\n"), Math.max(0, maxTokens * 4));
}

function buildTurns(entries: SessionEntry[], budgets: BudgetConfig): Turn[] {
	const turns: Turn[] = [];
	let current: Turn | null = null;

	const startTurn = (entryId: string) => {
		current = {
			index: turns.length,
			startEntryId: entryId,
			entryIds: [entryId],
			userText: "",
			assistantText: "",
			toolCalls: [],
			toolResults: [],
			filePaths: new Set<string>(),
			hasError: false,
			highSignal: false,
			searchText: "",
			goalScore: 0,
		};
	};

	const ensureTurn = (entryId: string) => {
		if (!current) {
			startTurn(entryId);
			return;
		}
		current.entryIds.push(entryId);
	};

	const finalizeTurn = () => {
		if (!current) return;
		const combined = [
			current.userText,
			current.assistantText,
			...current.toolCalls.map(formatToolCallDisplay),
			...current.toolResults.filter((result) => result.isError).map((result) => result.contentText),
		]
			.filter(Boolean)
			.join(" ");
		const normalized = normalizeText(combined).toLowerCase();
		current.searchText = normalized;
		current.highSignal = HIGH_SIGNAL_MARKERS.some((marker) => normalized.includes(marker));
		turns.push(current);
		current = null;
	};

	for (const entry of entries) {
		if (entry.type !== "message" && entry.type !== "custom_message") continue;

		if (entry.type === "custom_message") {
			ensureTurn(entry.id);
			const text = normalizeText(extractTextContent(entry.content as string | Array<{ type: string; text?: string }>));
			if (text && current) current.assistantText = [current.assistantText, text].filter(Boolean).join("\n");
			continue;
		}

		const msgEntry = entry as SessionMessageEntry;
		const message = msgEntry.message;

		if (message.role === "user") {
			finalizeTurn();
			startTurn(entry.id);
			const text = normalizeText(extractTextContent(message.content as string | Array<{ type: string; text?: string }>));
			if (text && current) current.userText = text;
			continue;
		}

		ensureTurn(entry.id);

		if (message.role === "assistant") {
			const assistantText = normalizeText(
				(message.content as Array<{ type: string; text?: string }>).filter((block) => block.type === "text")
					.map((block) => block.text ?? "")
					.join(""),
			);
			if (assistantText && current) {
				current.assistantText = [current.assistantText, assistantText].filter(Boolean).join("\n");
			}
			if (message.stopReason === "error" || message.errorMessage) {
				if (current) current.hasError = true;
			}

			for (const block of message.content as Array<{ type: string; name?: string; arguments?: Record<string, unknown> }>) {
				if (block.type !== "toolCall" || !block.name || !block.arguments) continue;
				const pathValue = typeof block.arguments.path === "string" ? block.arguments.path : undefined;
				const commandValue = typeof block.arguments.command === "string" ? block.arguments.command : undefined;
				const toolCall: ToolCallInfo = {
					name: block.name,
					path: pathValue && !isSensitivePath(pathValue) ? pathValue : undefined,
					command: commandValue ? redactSensitiveText(commandValue) : undefined,
				};
				current.toolCalls.push(toolCall);
				if (toolCall.path) current.filePaths.add(toolCall.path);
			}
			continue;
		}

		if (message.role === "toolResult") {
			const contentText = normalizeText(
				truncateLines(
					extractTextContent(message.content as string | Array<{ type: string; text?: string }>),
					budgets.maxToolOutputLines,
				),
			);
			current.toolResults.push({
				toolName: message.toolName,
				isError: message.isError,
				contentText,
			});
			if (message.isError) current.hasError = true;
		}
	}

	finalizeTurn();
	return turns;
}

function scoreTurn(turn: Turn, goalTokens: string[], goalLower: string): number {
	let score = 0;
	for (const token of goalTokens) {
		if (turn.searchText.includes(token)) score += token.length > 4 ? 2 : 1;
	}
	for (const path of turn.filePaths) {
		const lowerPath = path.toLowerCase();
		if (goalLower.includes(lowerPath)) score += 3;
		for (const token of goalTokens) {
			if (lowerPath.includes(token)) score += 1;
		}
	}
	return score;
}

function selectAnchors(turns: Turn[], goal: string, budgets: BudgetConfig): Map<number, SelectionResult> {
	const results = new Map<number, SelectionResult>();
	if (turns.length === 0) return results;

	const goalLower = goal.toLowerCase();
	const goalTokens = deriveGoalTokens(goal);
	const requiredIndices = new Set<number>();

	requiredIndices.add(0);
	const recentStart = Math.max(0, turns.length - budgets.recentTurnCount);
	for (let index = recentStart; index < turns.length; index += 1) {
		requiredIndices.add(index);
	}

	for (const turn of turns) {
		if (turn.hasError || turn.highSignal) requiredIndices.add(turn.index);
		turn.goalScore = scoreTurn(turn, goalTokens, goalLower);
	}

	const requiredTurns = turns.filter((turn) => requiredIndices.has(turn.index));
	const optionalTurns = turns
		.filter((turn) => !requiredIndices.has(turn.index))
		.sort((left, right) => right.goalScore - left.goalScore);

	let anchorTokens = 0;
	const markSelected = (turn: Turn, required: boolean, reasons: string[], tokenBudget: number) => {
		const excerpt = buildTurnExcerpt(turn, tokenBudget);
		anchorTokens += estimateTokens(excerpt);
		results.set(turn.index, { selected: true, required, reasons });
	};

	for (const turn of requiredTurns) {
		const reasons: string[] = [];
		if (turn.index === 0) reasons.push("first-user");
		if (turn.index >= recentStart) reasons.push("recent");
		if (turn.hasError) reasons.push("error");
		if (turn.highSignal) reasons.push("high-signal");
		markSelected(turn, true, reasons, budgets.requiredAnchorTokens);
	}

	for (const turn of optionalTurns) {
		if (anchorTokens >= budgets.anchorTokens) break;
		markSelected(turn, false, ["goal-match"], budgets.optionalAnchorTokens);
	}

	for (const turn of turns) {
		if (!results.has(turn.index)) {
			results.set(turn.index, { selected: false, required: false, reasons: [] });
		}
	}

	return results;
}

function buildTurnSnippet(turn: Turn): string {
	const parts = [
		`[User] ${turn.userText}`,
		turn.assistantText ? `[Assistant] ${turn.assistantText}` : "",
		turn.toolCalls.length > 0 ? `[Tools] ${turn.toolCalls.map(formatToolCallDisplay).join("; ")}` : "",
		turn.toolResults.filter((r) => r.isError).length > 0
			? `[Errors] ${turn.toolResults.filter((r) => r.isError).map((r) => `${r.toolName}: ${r.contentText}`).join("; ")}`
			: "",
	]
		.filter(Boolean)
		.join("\n");
	return truncateToChars(parts, MAX_SNIPPET_CHARS);
}

function runSubagent(prompt: string, cwd: string): Promise<{ success: boolean }> {
	return new Promise((resolve) => {
		const child = spawn("pi", ["--mode", "json", "--tools", "read,write", "-p", prompt], {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let textBuffer = "";
		const rl = createInterface({ input: child.stdout });

		rl.on("line", (line) => {
			try {
				const event: JsonEvent = JSON.parse(line);
				if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
					textBuffer += event.assistantMessageEvent.delta ?? "";
				} else if (event.type === "tool_execution_start" && event.toolName) {
					if (textBuffer.trim()) {
						console.log(chalk.dim("  " + truncateLine(textBuffer, MAX_DISPLAY_WIDTH)));
						textBuffer = "";
					}
					let argsStr = "";
					if (event.args) {
						if (event.toolName === "read") {
							argsStr = event.args.path ?? "";
							if (event.args.offset) argsStr += ` offset=${event.args.offset}`;
							if (event.args.limit) argsStr += ` limit=${event.args.limit}`;
						} else if (event.toolName === "write") {
							argsStr = event.args.path ?? "";
						}
					}
					console.log(chalk.cyan(`  [${event.toolName}] ${argsStr}`));
				} else if (event.type === "turn_end") {
					if (textBuffer.trim()) {
						console.log(chalk.dim("  " + truncateLine(textBuffer, MAX_DISPLAY_WIDTH)));
					}
					textBuffer = "";
				}
			} catch {
				return;
			}
		});

		child.stderr.on("data", (data) => {
			process.stderr.write(chalk.red(data.toString()));
		});

		child.on("close", (code) => {
			resolve({ success: code === 0 });
		});

		child.on("error", (err) => {
			console.error(chalk.red(`  Failed to spawn pi: ${err.message}`));
			resolve({ success: false });
		});
	});
}

async function main() {
	const args = process.argv.slice(2);
	const analyzeFlag = args.includes("--analyze");

	const outputIdx = args.indexOf("--output");
	const goalSourceIdx = args.indexOf("--goal-source");
	const topKIdx = args.indexOf("--top-k");

	const outputDir = outputIdx !== -1 && args[outputIdx + 1] ? resolve(args[outputIdx + 1]) : DEFAULT_OUTPUT_DIR;
	const goalSourceValue = goalSourceIdx !== -1 && args[goalSourceIdx + 1] ? args[goalSourceIdx + 1] : "auto";
	const validGoalSources: GoalSource[] = ["auto", "handoff", "last-user", "first-user", "summary-goal"];
	const goalSource = validGoalSources.includes(goalSourceValue as GoalSource)
		? (goalSourceValue as GoalSource)
		: "auto";
	const topKValue = topKIdx !== -1 && args[topKIdx + 1] ? Number(args[topKIdx + 1]) : DEFAULT_TOP_K;
	const topK = Number.isFinite(topKValue) && topKValue > 0 ? topKValue : DEFAULT_TOP_K;

	const flagIndices = new Set<number>();
	flagIndices.add(args.indexOf("--analyze"));
	if (outputIdx !== -1) {
		flagIndices.add(outputIdx);
		flagIndices.add(outputIdx + 1);
	}
	if (goalSourceIdx !== -1) {
		flagIndices.add(goalSourceIdx);
		flagIndices.add(goalSourceIdx + 1);
	}
	if (topKIdx !== -1) {
		flagIndices.add(topKIdx);
		flagIndices.add(topKIdx + 1);
	}

	const cwdArg = args.find((arg, index) => !flagIndices.has(index) && !arg.startsWith("--"));
	const cwd = resolve(cwdArg ?? process.cwd());

	mkdirSync(outputDir, { recursive: true });
	const analysisDir = join(outputDir, "analysis");
	if (analyzeFlag) {
		mkdirSync(analysisDir, { recursive: true });
	}

	const sessionsBase = join(homedir(), ".pi/agent/sessions");
	const sessionDirName = cwdToSessionDir(cwd);
	const sessionDir = join(sessionsBase, sessionDirName);

	if (!existsSync(sessionDir)) {
		console.error(`No sessions found for ${cwd}`);
		console.error(`Expected: ${sessionDir}`);
		process.exit(1);
	}

	const sessionFiles = readdirSync(sessionDir)
		.filter((file) => file.endsWith(".jsonl"))
		.sort();

	console.log(`Found ${sessionFiles.length} session files in ${sessionDir}`);

	const turnRecords: TurnRecord[] = [];
	const sessionSummaries: SessionSummary[] = [];

	for (const file of sessionFiles) {
		const filePath = join(sessionDir, file);
		const content = readFileSync(filePath, "utf8");
		const fileEntries = parseSessionEntries(content);
		const header = fileEntries.find((entry) => entry.type === "session") as SessionHeader | undefined;
		const sessionId = header?.id ?? "unknown";
		const entries = fileEntries.filter((entry) => entry.type !== "session") as SessionEntry[];
		if (entries.length === 0) continue;

		const goalInfo = resolveGoal(entries, goalSource);
		if (!goalInfo) {
			console.log(chalk.yellow(`Skipping ${file}: no goal found (source ${goalSource})`));
			continue;
		}

		const branch = buildBranch(entries, goalInfo.leafEntryId);
		if (branch.length === 0) continue;

		const turns = buildTurns(branch, DEFAULT_BUDGETS);
		const selection = selectAnchors(turns, goalInfo.goal, DEFAULT_BUDGETS);

		let selectedCount = 0;
		for (const turn of turns) {
			const selectionResult = selection.get(turn.index);
			if (!selectionResult) continue;
			if (selectionResult.selected) selectedCount += 1;

			const toolErrors = turn.toolResults
				.filter((result) => result.isError)
				.map((result) => `${result.toolName}: ${result.contentText}`);
			const toolCalls = turn.toolCalls.map(formatToolCallDisplay);
			const filePaths = [...turn.filePaths].filter((path) => !isSensitivePath(path));

			turnRecords.push({
				sessionFile: file,
				sessionId,
				goalSource: goalInfo.source,
				goal: goalInfo.goal,
				turnIndex: turn.index,
				entryId: turn.startEntryId,
				userText: truncateToChars(turn.userText, MAX_SNIPPET_CHARS),
				assistantText: truncateToChars(turn.assistantText, MAX_SNIPPET_CHARS),
				toolCalls,
				toolErrors,
				filePaths,
				hasError: turn.hasError,
				highSignal: turn.highSignal,
				goalScore: turn.goalScore,
				selected: selectionResult.selected,
				required: selectionResult.required,
				reasons: selectionResult.reasons,
			});
		}

		sessionSummaries.push({
			sessionFile: file,
			sessionId,
			goalSource: goalInfo.source,
			goal: goalInfo.goal,
			turnCount: turns.length,
			selectedCount,
		});

		if (analyzeFlag) {
			const snippetLines = turns.map((turn) => {
				const snippet = buildTurnSnippet(turn);
				return `Turn ${turn.index + 1} | entry ${turn.startEntryId}\n${snippet}`;
			});
			const analysisInputPath = join(analysisDir, `${sessionId}-input.txt`);
			const analysisOutputPath = join(analysisDir, `${sessionId}-analysis.json`);
			const analysisContent = [`Goal: ${goalInfo.goal}`, "", ...snippetLines].join("\n\n");
			writeFileSync(analysisInputPath, analysisContent);

			const analysisPrompt = `You are evaluating handoff heuristics.\n\nRead the file "${analysisInputPath}" in full. It contains a goal and turn snippets. Read it in chunks of 500 lines using offset/limit until complete.\n\nSelect the top ${topK} turns most relevant to the goal. Then suggest additional high-signal keywords or patterns to improve heuristics.\n\nOutput JSON to "${analysisOutputPath}" with this schema:\n{\n  "goal": string,\n  "selectedTurns": [{ "turn": number, "entryId": string, "reason": string }],\n  "suggestedMarkers": string[],\n  "notes": string\n}\n\nUse the turn number and entry id exactly as shown in the file. Only output JSON.`;

			console.log(`Analyzing ${file} (${turns.length} turns)...`);
			const result = await runSubagent(analysisPrompt, analysisDir);
			if (result.success && existsSync(analysisOutputPath)) {
				console.log(chalk.green(`  -> ${analysisOutputPath}`));
			} else if (result.success) {
				console.log(chalk.yellow(`  Agent finished but did not write ${analysisOutputPath}`));
			} else {
				console.log(chalk.red(`  Failed to analyze ${file}`));
			}
		}
	}

	const turnsPath = join(outputDir, "turns.jsonl");
	const sessionsPath = join(outputDir, "sessions.json");
	writeFileSync(turnsPath, turnRecords.map((record) => JSON.stringify(record)).join("\n"));
	writeFileSync(sessionsPath, JSON.stringify(sessionSummaries, null, 2));

	console.log(`Wrote ${turnRecords.length} turn records to ${turnsPath}`);
	console.log(`Wrote ${sessionSummaries.length} session summaries to ${sessionsPath}`);
}

main().catch((err) => {
	console.error(err instanceof Error ? err.message : String(err));
	process.exit(1);
});
