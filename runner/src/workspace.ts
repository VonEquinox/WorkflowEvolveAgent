/**
 * Per-run Git worktree isolation.
 *
 * A live run never edits the caller's checkout. We create a detached worktree,
 * reproduce the caller's current tracked/untracked state as a private baseline
 * commit, execute agents there, and later export a patch relative to that
 * baseline. The source checkout and branch are never merged or reset.
 */

import { execFileSync, spawnSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	realpathSync,
	rmSync,
	symlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export interface IsolatedWorkspace {
	runId: string;
	sourceRepoRoot: string;
	sourceRequestedPath: string;
	requestedRelativePath: string;
	worktreeRoot: string;
	cwd: string;
	baseCommit: string;
	baselineCommit: string;
	sourceWasDirty: boolean;
	dependencyLinks: string[];
}

export interface WorkspaceResult {
	worktreeRoot: string;
	baselineCommit: string;
	status: string;
	patch: string;
	changedFiles: string[];
	commits: string[];
}

function git(cwd: string, args: string[], allowFailure = false): string {
	try {
		return execFileSync("git", ["-C", cwd, ...args], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		}).trimEnd();
	} catch (err: any) {
		if (allowFailure) return "";
		const detail = String(err?.stderr ?? err?.message ?? err).trim();
		throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${detail}`);
	}
}

function gitRaw(cwd: string, args: string[]): string {
	try {
		return execFileSync("git", ["-C", cwd, ...args], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch (err: any) {
		const detail = String(err?.stderr ?? err?.message ?? err).trim();
		throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${detail}`);
	}
}

function applyPatch(cwd: string, patch: string): void {
	if (!patch) return;
	const result = spawnSync("git", ["-C", cwd, "apply", "--binary", "--whitespace=nowarn", "-"], {
		input: patch,
		encoding: "utf8",
	});
	if (result.status !== 0) {
		throw new Error(`failed to reproduce source dirty state in worktree: ${String(result.stderr || result.stdout).trim()}`);
	}
}

function safeRelative(root: string, path: string): string {
	const rel = relative(root, path);
	if (rel === "") return ".";
	if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`${path} is outside Git repository ${root}`);
	return rel;
}

function copyUntracked(sourceRoot: string, worktreeRoot: string): string[] {
	const raw = execFileSync(
		"git",
		["-C", sourceRoot, "ls-files", "--others", "--exclude-standard", "-z"],
		{ encoding: "utf8" },
	);
	const files = raw.split("\0").filter(Boolean);
	for (const rel of files) {
		const source = join(sourceRoot, rel);
		const target = join(worktreeRoot, rel);
		mkdirSync(dirname(target), { recursive: true });
		cpSync(source, target, { recursive: true, preserveTimestamps: true, dereference: false });
	}
	return files;
}

const DEPENDENCY_DIRS = new Set(["node_modules", ".venv", "venv"]);

/** Reuse large ignored dependency directories without copying them. */
function linkIgnoredDependencies(sourceRoot: string, worktreeRoot: string): string[] {
	const linked: string[] = [];
	const visit = (dir: string, depth: number) => {
		if (depth > 3) return;
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (entry.name === ".git") continue;
			const source = join(dir, entry.name);
			const rel = relative(sourceRoot, source);
			if (DEPENDENCY_DIRS.has(entry.name) && entry.isDirectory()) {
				const ignored = spawnSync("git", ["-C", sourceRoot, "check-ignore", "-q", "--", rel]).status === 0;
				if (!ignored) continue;
				const target = join(worktreeRoot, rel);
				if (!existsSync(target)) {
					mkdirSync(dirname(target), { recursive: true });
					symlinkSync(source, target, "dir");
					linked.push(rel);
				}
				continue;
			}
			if (entry.isDirectory()) visit(source, depth + 1);
		}
	};
	visit(sourceRoot, 0);
	return linked;
}

export function defaultWorktreeBaseDir(): string {
	return process.env.WEA_WORKTREE_ROOT ?? join(homedir(), ".cache", "wea", "worktrees");
}

export function prepareIsolatedWorkspace(opts: {
	repo: string;
	runId: string;
	worktreeBaseDir?: string;
}): IsolatedWorkspace {
	const requested = realpathSync(resolve(opts.repo));
	const sourceRepoRoot = realpathSync(git(requested, ["rev-parse", "--show-toplevel"]));
	const requestedRelativePath = safeRelative(sourceRepoRoot, requested);
	const baseCommit = git(sourceRepoRoot, ["rev-parse", "HEAD"]);
	const baseDir = resolve(opts.worktreeBaseDir ?? defaultWorktreeBaseDir());
	const worktreeRoot = join(baseDir, opts.runId);
	if (existsSync(worktreeRoot)) throw new Error(`worktree path already exists: ${worktreeRoot}`);
	mkdirSync(baseDir, { recursive: true });

	try {
		git(sourceRepoRoot, ["worktree", "add", "--detach", worktreeRoot, baseCommit]);
		const dirtyPatch = gitRaw(sourceRepoRoot, ["diff", "--binary", "HEAD", "--"]);
		applyPatch(worktreeRoot, dirtyPatch);
		const untracked = copyUntracked(sourceRepoRoot, worktreeRoot);
		const sourceWasDirty = dirtyPatch.length > 0 || untracked.length > 0;
		let baselineCommit = baseCommit;
		if (sourceWasDirty) {
			git(worktreeRoot, ["add", "-A"]);
			git(worktreeRoot, [
				"-c",
				"user.name=WorkflowEvolveAgent",
				"-c",
				"user.email=wea@localhost",
				"commit",
				"-m",
				`WEA isolated baseline ${opts.runId}`,
			]);
			baselineCommit = git(worktreeRoot, ["rev-parse", "HEAD"]);
		}
		const dependencyLinks = linkIgnoredDependencies(sourceRepoRoot, worktreeRoot);
		const cwd = requestedRelativePath === "." ? worktreeRoot : join(worktreeRoot, requestedRelativePath);
		if (!existsSync(cwd) || !lstatSync(cwd).isDirectory()) {
			throw new Error(`requested repo subdirectory is missing in isolated worktree: ${cwd}`);
		}
		return {
			runId: opts.runId,
			sourceRepoRoot,
			sourceRequestedPath: requested,
			requestedRelativePath,
			worktreeRoot,
			cwd,
			baseCommit,
			baselineCommit,
			sourceWasDirty,
			dependencyLinks,
		};
	} catch (err) {
		try {
			git(sourceRepoRoot, ["worktree", "remove", "--force", worktreeRoot], true);
		} finally {
			rmSync(worktreeRoot, { recursive: true, force: true });
		}
		throw err;
	}
}

export function captureWorkspaceResult(workspace: IsolatedWorkspace): WorkspaceResult {
	git(workspace.worktreeRoot, ["add", "-N", "--all"], true);
	const patch = gitRaw(workspace.worktreeRoot, ["diff", "--binary", "--no-ext-diff", workspace.baselineCommit, "--"]);
	const changed = git(workspace.worktreeRoot, ["diff", "--name-only", workspace.baselineCommit, "--"]);
	const commitsRaw = git(workspace.worktreeRoot, [
		"log",
		"--format=%H%x09%s",
		`${workspace.baselineCommit}..HEAD`,
	], true);
	return {
		worktreeRoot: workspace.worktreeRoot,
		baselineCommit: workspace.baselineCommit,
		status: git(workspace.worktreeRoot, ["status", "--porcelain=v1", "--untracked-files=all"], true),
		patch,
		changedFiles: changed ? changed.split("\n").filter(Boolean) : [],
		commits: commitsRaw ? commitsRaw.split("\n").filter(Boolean) : [],
	};
}

export function removeIsolatedWorkspace(workspace: IsolatedWorkspace): void {
	git(workspace.sourceRepoRoot, ["worktree", "remove", "--force", workspace.worktreeRoot], true);
	rmSync(workspace.worktreeRoot, { recursive: true, force: true });
	git(workspace.sourceRepoRoot, ["worktree", "prune"], true);
}
