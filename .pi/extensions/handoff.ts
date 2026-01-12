import type { AgentMessage } from "@mariozechner/pi-agent-core";
import {
	complete,
	type AssistantMessage,
	type ImageContent,
	type Message,
	type TextContent,
	type ToolResultMessage,
	type UserMessage,
} from "@mariozechner/pi-ai";
import type { ExtensionAPI, SessionEntry } from "@mariozechner/pi-coding-agent";
import { BorderedLoader } from "@mariozechner/pi-coding-agent";

const EXTRACT_SYSTEM_PROMPT = `You are a handoff extraction assistant. Given a goal and curated excerpts from a coding session, extract the essential information to continue work in a new session.

Output a structured facts bundle in this EXACT format:

## Goal
[Restate the handoff goal]

## Constraints & Preferences
- ...

## Decisions
- **Decision**: Rationale

## Progress
### Done
- [x] ...

### In Progress
- [ ] ...

### Blocked
- ...

## Errors
- ... (include exact error snippets)

## Operational Highlights
- ... (commands to rerun, notable failures)

## Files
- path — reason (read/modified)

## Notes
- Risks, gotchas, what not to redo

Only include details grounded in the excerpts. Keep it concise and actionable.`;

const COMPOSE_SYSTEM_PROMPT = `You are a handoff composer. Turn the extracted facts bundle into a first message for a new session.

Requirements:
- Output ONLY the prompt (no preamble).
- Use this structure:
  - ## Context
  - ## Operational Context
  - ## Files
  - ## Task
  - ## Notes
- Preserve exact paths, commands, error messages, and decisions.
- Keep it direct and actionable.
- Include machine-parseable blocks:
  <read-files>...</read-files>
  <modified-files>...</modified-files>
- Avoid transcript dumps. Prefer references and concise summaries.`;

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

type BudgetConfig = {
	maxExtractTokens: number;
	summaryTokens: number;
	summaryEntryTokens: number;
	anchorTokens: number;
	requiredAnchorTokens: number;
	optionalAnchorTokens: number;
	operationalTokens: number;
	fileTokens: number;
	composeInputTokens: number;
	maxToolOutputLines: number;
	maxOperationalItems: number;
	recentTurnCount: number;
	maxFileEntries: number;
};

const DEFAULT_BUDGETS: BudgetConfig = {
	maxExtractTokens: 7000,
	summaryTokens: 1800,
	summaryEntryTokens: 600,
	anchorTokens: 2600,
	requiredAnchorTokens: 220,
	optionalAnchorTokens: 260,
	operationalTokens: 800,
	fileTokens: 400,
	composeInputTokens: 2200,
	maxToolOutputLines: 8,
	maxOperationalItems: 10,
	recentTurnCount: 2,
	maxFileEntries: 60,
};

type ToolCallInfo = {
	id: string;
	name: string;
	arguments: Record<string, unknown>;
	entryId: string;
};

type ToolResultInfo = {
	toolCallId: string;
	toolName: string;
	isError: boolean;
	contentText: string;
	entryId: string;
};

type Turn = {
	index: number;
	startEntryId: string;
	entryIds: string[];
	userText: string;
	assistantTexts: string[];
	toolCalls: ToolCallInfo[];
	toolResults: ToolResultInfo[];
	extraTexts: string[];
	filePaths: Set<string>;
	toolsUsed: Set<string>;
	hasError: boolean;
	highSignal: boolean;
	searchText: string;
	goalScore: number;
};

type SummaryEntry = {
	type: "compaction" | "branch_summary";
	summary: string;
	entryId: string;
	details?: unknown;
};

type FileOperations = {
	read: Set<string>;
	modified: Set<string>;
};

type BranchIndex = {
	turns: Turn[];
	summaryEntries: SummaryEntry[];
	fileOps: FileOperations;
	toolCallsById: Map<string, ToolCallInfo>;
};

type Anchor = {
	turn: Turn;
	reason: string;
	excerpt: string;
	required: boolean;
};

type OperationalItem = {
	text: string;
	isError: boolean;
	score: number;
};

function estimateTokens(text: string): number {
	if (!text) return 0;
	return Math.ceil(text.length / 4);
}

function truncateToTokens(text: string, maxTokens: number): string {
	if (!text) return "";
	if (maxTokens <= 0) return "";
	if (estimateTokens(text) <= maxTokens) return text;
	const maxChars = Math.max(0, Math.floor(maxTokens * 4));
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}\n...[truncated]`;
}

function truncateLines(text: string, maxLines: number): string {
	if (!text) return "";
	const lines = text.split("\n");
	if (lines.length <= maxLines) return text;
	const remaining = lines.length - maxLines;
	return `${lines.slice(0, maxLines).join("\n")}\n...[${remaining} more lines truncated]`;
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

function getTextFromContent(content: string | Array<TextContent | ImageContent>): string {
	if (typeof content === "string") return content;
	return content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("");
}

function isUserMessage(message: AgentMessage): message is UserMessage {
	const role = (message as { role?: unknown }).role;
	return role === "user";
}

function isAssistantMessage(message: AgentMessage): message is AssistantMessage {
	const role = (message as { role?: unknown }).role;
	return role === "assistant";
}

function isToolResultMessage(message: AgentMessage): message is ToolResultMessage {
	const role = (message as { role?: unknown }).role;
	return role === "toolResult";
}

function normalizeText(text: string): string {
	return redactSensitiveText(text.trim());
}

function extractToolCalls(message: AssistantMessage, entryId: string): ToolCallInfo[] {
	const calls: ToolCallInfo[] = [];
	for (const block of message.content) {
		if (block.type !== "toolCall") continue;
		const args = block.arguments as Record<string, unknown>;
		calls.push({
			id: block.id,
			name: block.name,
			arguments: args,
			entryId,
		});
	}
	return calls;
}

function formatToolCallForSearch(toolCall: ToolCallInfo): string {
	const path = getStringArg(toolCall.arguments, "path");
	const command = getStringArg(toolCall.arguments, "command");
	const safeCommand = command ? redactSensitiveText(command) : undefined;
	const safePath = path && !isSensitivePath(path) ? path : path ? "[redacted]" : undefined;
	if (toolCall.name === "bash" && safeCommand) return `bash ${safeCommand}`;
	if (safePath) return `${toolCall.name} ${safePath}`;
	return toolCall.name;
}

function formatToolCallDisplay(toolCall: ToolCallInfo): string {
	const path = getStringArg(toolCall.arguments, "path");
	const command = getStringArg(toolCall.arguments, "command");
	const safeCommand = command ? redactSensitiveText(command) : undefined;
	const safePath = path && !isSensitivePath(path) ? path : path ? "[redacted]" : undefined;
	if (toolCall.name === "bash" && safeCommand) {
		return `bash(command=${JSON.stringify(truncateInline(safeCommand, 180))})`;
	}
	if (safePath) {
		return `${toolCall.name}(path=${JSON.stringify(safePath)})`;
	}
	return toolCall.name;
}

function getStringArg(args: Record<string, unknown> | undefined, key: string): string | undefined {
	if (!args) return undefined;
	const value = args[key];
	return typeof value === "string" ? value : undefined;
}

function truncateInline(text: string, maxLength: number): string {
	if (text.length <= maxLength) return text;
	return `${text.slice(0, maxLength)}...`;
}

function collectFileOpsFromToolCall(
	toolCall: ToolCallInfo,
	fileOps: FileOperations,
	turn: Turn,
): void {
	const path = getStringArg(toolCall.arguments, "path");
	if (!path) return;
	turn.filePaths.add(path);
	if (toolCall.name === "read") {
		fileOps.read.add(path);
		return;
	}
	if (toolCall.name === "write" || toolCall.name === "edit") {
		fileOps.modified.add(path);
	}
}

function collectFileOpsFromSummary(details: unknown, fileOps: FileOperations): void {
	if (!details || typeof details !== "object") return;
	const detailRecord = details as { readFiles?: unknown; modifiedFiles?: unknown };
	if (Array.isArray(detailRecord.readFiles)) {
		for (const item of detailRecord.readFiles) {
			if (typeof item === "string") fileOps.read.add(item);
		}
	}
	if (Array.isArray(detailRecord.modifiedFiles)) {
		for (const item of detailRecord.modifiedFiles) {
			if (typeof item === "string") fileOps.modified.add(item);
		}
	}
}

function createTurn(index: number, entryId: string): Turn {
	return {
		index,
		startEntryId: entryId,
		entryIds: [entryId],
		userText: "",
		assistantTexts: [],
		toolCalls: [],
		toolResults: [],
		extraTexts: [],
		filePaths: new Set<string>(),
		toolsUsed: new Set<string>(),
		hasError: false,
		highSignal: false,
		searchText: "",
		goalScore: 0,
	};
}

function finalizeTurn(turn: Turn): void {
	const combined = [
		turn.userText,
		...turn.assistantTexts,
		...turn.extraTexts,
		...turn.toolCalls.map(formatToolCallForSearch),
		...turn.toolResults.filter((result) => result.isError).map((result) => result.contentText),
	]
		.filter(Boolean)
		.join(" ");
	const normalized = normalizeText(combined).toLowerCase();
	turn.searchText = normalized;
	turn.highSignal = HIGH_SIGNAL_MARKERS.some((marker) => normalized.includes(marker));
}

function buildBranchIndex(entries: SessionEntry[]): BranchIndex {
	const turns: Turn[] = [];
	const summaryEntries: SummaryEntry[] = [];
	const fileOps: FileOperations = { read: new Set(), modified: new Set() };
	const toolCallsById = new Map<string, ToolCallInfo>();
	let currentTurn: Turn | undefined;

	const startTurn = (entryId: string) => {
		currentTurn = createTurn(turns.length, entryId);
	};

	const ensureTurn = (entryId: string) => {
		if (!currentTurn) {
			startTurn(entryId);
			return;
		}
		currentTurn.entryIds.push(entryId);
	};

	const pushTurn = () => {
		if (!currentTurn) return;
		finalizeTurn(currentTurn);
		turns.push(currentTurn);
		currentTurn = undefined;
	};

	for (const entry of entries) {
		if (entry.type === "compaction" || entry.type === "branch_summary") {
			summaryEntries.push({
				type: entry.type,
				summary: entry.summary,
				entryId: entry.id,
				details: entry.details,
			});
			collectFileOpsFromSummary(entry.details, fileOps);
			continue;
		}

		if (entry.type === "custom_message") {
			ensureTurn(entry.id);
			const text = normalizeText(getTextFromContent(entry.content));
			if (text) currentTurn?.extraTexts.push(text);
			continue;
		}

		if (entry.type !== "message") continue;

		const message = entry.message;

		if (isUserMessage(message)) {
			pushTurn();
			startTurn(entry.id);
			const text = normalizeText(getTextFromContent(message.content));
			if (text && currentTurn) currentTurn.userText = text;
			continue;
		}

		ensureTurn(entry.id);

		if (isAssistantMessage(message)) {
			const text = normalizeText(
				message.content
					.filter((block): block is TextContent => block.type === "text")
					.map((block) => block.text)
					.join(""),
			);
			if (text) currentTurn?.assistantTexts.push(text);
			if (message.stopReason === "error" || message.errorMessage) {
				if (currentTurn) currentTurn.hasError = true;
			}
			const toolCalls = extractToolCalls(message, entry.id);
			for (const toolCall of toolCalls) {
				toolCallsById.set(toolCall.id, toolCall);
				currentTurn?.toolCalls.push(toolCall);
				currentTurn?.toolsUsed.add(toolCall.name);
				if (currentTurn) {
					collectFileOpsFromToolCall(toolCall, fileOps, currentTurn);
				}
			}
			continue;
		}

		if (isToolResultMessage(message)) {
			const contentText = normalizeText(
				truncateLines(getTextFromContent(message.content), DEFAULT_BUDGETS.maxToolOutputLines),
			);
			currentTurn?.toolResults.push({
				toolCallId: message.toolCallId,
				toolName: message.toolName,
				isError: message.isError,
				contentText,
				entryId: entry.id,
			});
			if (message.isError && currentTurn) currentTurn.hasError = true;
		}
	}

	pushTurn();

	return { turns, summaryEntries, fileOps, toolCallsById };
}

function computeFileLists(fileOps: FileOperations, maxEntries: number): { readFiles: string[]; modifiedFiles: string[] } {
	const modifiedFiles = [...fileOps.modified].sort();
	const readFiles = [...fileOps.read].filter((path) => !fileOps.modified.has(path)).sort();
	return {
		readFiles: readFiles.slice(0, maxEntries),
		modifiedFiles: modifiedFiles.slice(0, maxEntries),
	};
}

function deriveGoalTokens(goal: string): string[] {
	return goal
		.toLowerCase()
		.split(/[^a-z0-9_./-]+/)
		.filter((token) => token.length >= 3);
}

function scoreTurn(turn: Turn, goalTokens: string[], goalLower: string): number {
	if (!goalTokens.length) return 0;
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

function buildTurnExcerpt(turn: Turn, maxTokens: number): string {
	const lines: string[] = [];
	if (turn.userText) lines.push(`[User]: ${turn.userText}`);
	const assistantText = turn.assistantTexts.join("\n");
	if (assistantText) lines.push(`[Assistant]: ${assistantText}`);
	if (turn.toolCalls.length > 0) {
		const callText = turn.toolCalls.map(formatToolCallDisplay).join("; ");
		lines.push(`[Assistant tool calls]: ${callText}`);
	}
	const errorResults = turn.toolResults.filter((result) => result.isError);
	if (errorResults.length > 0) {
		const snippets = errorResults.map((result) => summarizeToolResult(result)).join("\n");
		lines.push(`[Tool errors]: ${snippets}`);
	}
	if (turn.extraTexts.length > 0) {
		lines.push(`[Custom]: ${turn.extraTexts.join("\n")}`);
	}
	return truncateToTokens(lines.join("\n"), maxTokens);
}

function summarizeToolResult(result: ToolResultInfo): string {
	if (!result.contentText) return `${result.toolName}: error (no output)`;
	return `${result.toolName}: ${result.contentText}`;
}

function selectAnchors(turns: Turn[], goal: string, budgets: BudgetConfig): Anchor[] {
	if (turns.length === 0) return [];
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

	const anchors: Anchor[] = [];
	let anchorTokens = 0;

	const addAnchor = (turn: Turn, reason: string, required: boolean, tokenBudget: number) => {
		const excerpt = buildTurnExcerpt(turn, tokenBudget);
		const excerptTokens = estimateTokens(excerpt);
		anchorTokens += excerptTokens;
		anchors.push({ turn, reason, excerpt, required });
	};

	for (const turn of requiredTurns) {
		const reason = turn.index === 0 ? "first user" : turn.hasError ? "error" : "key signal";
		addAnchor(turn, reason, true, budgets.requiredAnchorTokens);
	}

	for (const turn of optionalTurns) {
		if (anchorTokens >= budgets.anchorTokens) break;
		addAnchor(turn, "goal match", false, budgets.optionalAnchorTokens);
	}

	return anchors;
}

function buildSummarySection(summaryEntries: SummaryEntry[], budgets: BudgetConfig): string {
	if (summaryEntries.length === 0) return "(none)";
	const sections: string[] = [];
	let remainingTokens = budgets.summaryTokens;
	const remainingCount = summaryEntries.length;
	const perEntryCap = Math.min(budgets.summaryEntryTokens, Math.floor(remainingTokens / remainingCount));

	for (const entry of summaryEntries) {
		const sanitized = redactSensitiveText(entry.summary);
		const snippet = truncateToTokens(sanitized, Math.max(120, perEntryCap));
		remainingTokens -= estimateTokens(snippet);
		sections.push(`[${entry.type} ${entry.entryId}]\n${snippet}`);
	}

	return sections.join("\n\n");
}

function buildAnchorSection(anchors: Anchor[]): string {
	if (anchors.length === 0) return "(none)";
	return anchors
		.map((anchor) => {
			const header = `Turn ${anchor.turn.index + 1} (${anchor.reason})`;
			return `### ${header}\n${anchor.excerpt}`;
		})
		.join("\n\n");
}

function buildOperationalItems(
	turns: Turn[],
	toolCallsById: Map<string, ToolCallInfo>,
	budgets: BudgetConfig,
): OperationalItem[] {
	const items: OperationalItem[] = [];
	const seen = new Set<string>();

	for (const turn of turns) {
		const turnBoost = turn.goalScore > 0 ? 2 : 0;
		for (const result of turn.toolResults) {
			const toolCall = toolCallsById.get(result.toolCallId);
			const command = toolCall?.name === "bash" ? getStringArg(toolCall.arguments, "command") : undefined;
			if (!result.isError && toolCall?.name !== "bash") continue;
			const errorSnippet = result.isError ? result.contentText : "ok";
			const text = command
				? `bash: ${truncateInline(command, 200)} -> ${truncateInline(errorSnippet, 200)}`
				: `${result.toolName}: ${truncateInline(errorSnippet, 200)}`;
			const sanitized = redactSensitiveText(text);
			if (seen.has(sanitized)) continue;
			seen.add(sanitized);
			items.push({
				text: sanitized,
				isError: result.isError,
				score: (result.isError ? 5 : 1) + turnBoost + turn.goalScore,
			});
		}
	}

	const errors = items.filter((item) => item.isError).sort((left, right) => right.score - left.score);
	const successes = items
		.filter((item) => !item.isError)
		.sort((left, right) => right.score - left.score)
		.slice(0, budgets.maxOperationalItems);

	return [...errors, ...successes].slice(0, budgets.maxOperationalItems);
}

function buildOperationalSection(items: OperationalItem[], budgets: BudgetConfig): string {
	if (items.length === 0) return "(none)";
	const lines = items.map((item) => `- ${item.text}`);
	return truncateToTokens(lines.join("\n"), budgets.operationalTokens);
}

function buildFileSection(readFiles: string[], modifiedFiles: string[], budgets: BudgetConfig): string {
	if (readFiles.length === 0 && modifiedFiles.length === 0) return "(none)";
	const lines: string[] = [];
	if (readFiles.length > 0) {
		lines.push("Read-only:");
		lines.push(...readFiles.map((file) => `- ${file}`));
	}
	if (modifiedFiles.length > 0) {
		lines.push("Modified:");
		lines.push(...modifiedFiles.map((file) => `- ${file}`));
	}
	return truncateToTokens(lines.join("\n"), budgets.fileTokens);
}

function formatFileBlocks(readFiles: string[], modifiedFiles: string[]): string {
	const blocks: string[] = [];
	if (readFiles.length > 0) {
		blocks.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
	}
	if (modifiedFiles.length > 0) {
		blocks.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
	}
	return blocks.join("\n\n");
}

function ensureFileBlocks(text: string, readFiles: string[], modifiedFiles: string[]): string {
	let result = text.trim();
	const hasRead = /<read-files>[\s\S]*?<\/read-files>/i.test(result);
	const hasModified = /<modified-files>[\s\S]*?<\/modified-files>/i.test(result);
	const blocks = formatFileBlocks(readFiles, modifiedFiles);
	if (!blocks) return result;
	if (!hasRead || !hasModified) {
		result = `${result}\n\n${blocks}`;
	}
	return result;
}

function buildExtractorInput(
	goal: string,
	branchIndex: BranchIndex,
	anchors: Anchor[],
	operationalItems: OperationalItem[],
	fileLists: { readFiles: string[]; modifiedFiles: string[] },
	budgets: BudgetConfig,
): string {
	const summarySection = buildSummarySection(branchIndex.summaryEntries, budgets);
	const anchorSection = buildAnchorSection(anchors);
	const operationalSection = buildOperationalSection(operationalItems, budgets);
	const fileSection = buildFileSection(fileLists.readFiles, fileLists.modifiedFiles, budgets);

	const content = [
		`Goal: ${goal}`,
		"\nSummaries (compaction/branch summaries):\n" + summarySection,
		"\nAnchors (goal-conditioned excerpts across branch):\n" + anchorSection,
		"\nOperational context (curated):\n" + operationalSection,
		"\nFiles (from tool calls/summaries):\n" + fileSection,
	]
		.join("\n\n")
		.trim();

	return truncateToTokens(content, budgets.maxExtractTokens);
}

function buildComposerInput(
	goal: string,
	extracted: string,
	operationalItems: OperationalItem[],
	fileLists: { readFiles: string[]; modifiedFiles: string[] },
	budgets: BudgetConfig,
): string {
	const operationalSection = buildOperationalSection(operationalItems, budgets);
	const fileSection = buildFileSection(fileLists.readFiles, fileLists.modifiedFiles, budgets);
	const content = [
		`Goal: ${goal}`,
		"\nExtracted facts bundle:\n" + extracted,
		"\nOperational context (curated):\n" + operationalSection,
		"\nFiles (from tool calls/summaries):\n" + fileSection,
	]
		.join("\n\n")
		.trim();

	return truncateToTokens(content, budgets.composeInputTokens);
}

function filterSensitiveFileOps(fileLists: { readFiles: string[]; modifiedFiles: string[] }) {
	return {
		readFiles: fileLists.readFiles.filter((path) => !isSensitivePath(path)),
		modifiedFiles: fileLists.modifiedFiles.filter((path) => !isSensitivePath(path)),
	};
}

async function runCompletion(
	ctx: { model: NonNullable<ExtensionAPI["model"]>; modelRegistry: ExtensionAPI["modelRegistry"] },
	systemPrompt: string,
	userContent: string,
	signal: AbortSignal,
	maxTokens: number,
): Promise<string | null> {
	const apiKey = await ctx.modelRegistry.getApiKey(ctx.model);
	if (!apiKey) return null;
	const userMessage: Message = {
		role: "user",
		content: [{ type: "text", text: userContent }],
		timestamp: Date.now(),
	};
	const response = await complete(
		ctx.model,
		{ systemPrompt, messages: [userMessage] },
		{ apiKey, signal, maxTokens },
	);
	if (response.stopReason === "aborted") return null;
	return response.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n")
		.trim();
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("handoff", {
		description: "Transfer context to a new focused session",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("handoff requires interactive mode", "error");
				return;
			}

			if (!ctx.model) {
				ctx.ui.notify("No model selected", "error");
				return;
			}

			const goal = args.trim();
			if (!goal) {
				ctx.ui.notify("Usage: /handoff <goal for new thread>", "error");
				return;
			}

			const branch = ctx.sessionManager.getBranch();
			if (branch.length === 0) {
				ctx.ui.notify("No session entries to hand off", "error");
				return;
			}

			const branchIndex = buildBranchIndex(branch);
			if (branchIndex.turns.length === 0) {
				ctx.ui.notify("No conversation turns to hand off", "error");
				return;
			}

			const fileLists = computeFileLists(branchIndex.fileOps, DEFAULT_BUDGETS.maxFileEntries);
			const filteredFileLists = filterSensitiveFileOps(fileLists);
			const anchors = selectAnchors(branchIndex.turns, goal, DEFAULT_BUDGETS);
			const operationalItems = buildOperationalItems(
				branchIndex.turns,
				branchIndex.toolCallsById,
				DEFAULT_BUDGETS,
			);

			const extractInput = buildExtractorInput(
				goal,
				branchIndex,
				anchors,
				operationalItems,
				filteredFileLists,
				DEFAULT_BUDGETS,
			);
			const currentSessionFile = ctx.sessionManager.getSessionFile();

			const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
				const loader = new BorderedLoader(tui, theme, "Building handoff bundle...");
				loader.onAbort = () => done(null);

				const run = async () => {
					try {
						const extracted = await runCompletion(
							{ model: ctx.model!, modelRegistry: ctx.modelRegistry },
							EXTRACT_SYSTEM_PROMPT,
							extractInput,
							loader.signal,
							2400,
						);
						if (!extracted) {
							done(null);
							return;
						}

						const composeInput = buildComposerInput(
							goal,
							extracted,
							operationalItems,
							filteredFileLists,
							DEFAULT_BUDGETS,
						);

						const composed = await runCompletion(
							{ model: ctx.model!, modelRegistry: ctx.modelRegistry },
							COMPOSE_SYSTEM_PROMPT,
							composeInput,
							loader.signal,
							1600,
						);
						if (!composed) {
							done(null);
							return;
						}

						const withFiles = ensureFileBlocks(
							composed,
							filteredFileLists.readFiles,
							filteredFileLists.modifiedFiles,
						);
						done(withFiles);
					} catch (error: unknown) {
						console.error("Handoff generation failed:", error instanceof Error ? error.message : String(error));
						done(null);
					}
				};

				void run();
				return loader;
			});

			if (result === null) {
				ctx.ui.notify("Cancelled", "info");
				return;
			}

			const editedPrompt = await ctx.ui.editor("Edit handoff prompt", result);
			if (editedPrompt === undefined) {
				ctx.ui.notify("Cancelled", "info");
				return;
			}

			pi.appendEntry("handoff", {
				goal,
				timestamp: Date.now(),
			});

			const newSessionResult = await ctx.newSession({ parentSession: currentSessionFile });
			if (newSessionResult.cancelled) {
				ctx.ui.notify("New session cancelled", "info");
				return;
			}

			ctx.ui.setEditorText(editedPrompt);
			ctx.ui.notify("Handoff ready. Submit when ready.", "info");
		},
	});
}
