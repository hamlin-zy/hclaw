import {simpleGit, SimpleGit} from 'simple-git';
import {PluginError, PluginManifest, PluginSource} from './types';
import * as fs from 'fs';
import * as path from 'path';

export interface UpdateOptions {
  force?: boolean
}

export interface UpdateResult {
  success: boolean
  path?: string
  updated?: boolean
  forceApplied?: boolean
  dirtyFiles?: string[]
  error?: PluginError
}

/**
 * PluginInstaller - Handles plugin installation, uninstallation, and updates
 *
 * Design Rationale:
 * - Uses simple-git for Git operations (clone, pull)
 * - Validates plugin structure before completing installation
 * - Distinguishes between install (fresh clone) and update (git pull)
 * - Target path format: ${pluginsDir}/${pluginName}@github
 */
export class PluginInstaller {
  private pluginsDir: string;
  private git: SimpleGit;

  /** Known git hosts and their directory naming conventions */
  private static readonly HOST_MAP: Record<string, { host: string; suffix: string }> = {
    github: { host: 'github.com', suffix: '@github' },
    gitee: { host: 'gitee.com', suffix: '@gitee' },
    gitlab: { host: 'gitlab.com', suffix: '@gitlab' },
  };

  constructor(pluginsDir: string) {
    this.pluginsDir = pluginsDir;
    this.git = simpleGit();
  }

  /**
   * Install a plugin from a PluginSource
   * If the plugin directory already exists, performs an update (git pull)
   * Otherwise, clones the repository fresh
   */
  async install(source: PluginSource): Promise<{ success: boolean; path?: string; error?: PluginError }> {
    try {
      if (source.source === 'local') {
        return this.installLocal(source.path);
      }

      if (source.source === 'github' || source.source === 'gitee' || source.source === 'gitlab') {
        const info = PluginInstaller.HOST_MAP[source.source];
        return this.installRemote(info.host, source.repo, info.suffix, source.ref);
      }

      if (source.source === 'url') {
        const parsed = this.parseGithubUrl(source.url)
          || this.parseGiteeUrl(source.url)
          || this.parseGitlabUrl(source.url);
        if (parsed && (parsed.source === 'github' || parsed.source === 'gitee' || parsed.source === 'gitlab')) {
          const info = PluginInstaller.HOST_MAP[parsed.source];
          return this.installRemote(info.host, parsed.repo, info.suffix, source.ref || parsed.ref);
        }
        return { success: false, error: { type: 'git-clone-failed', message: 'Invalid URL format' } };
      }

      return { success: false, error: { type: 'git-clone-failed', message: 'Unknown source type' } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: { type: 'git-clone-failed', message } };
    }
  }

  /**
   * Install a plugin from a local path
   */
  private installLocal(localPath: string): { success: boolean; path?: string; error?: PluginError } {
    const validation = this.validate(localPath);
    if (!validation.valid) {
      return { success: false, error: validation.error };
    }

    const manifest = validation.manifest!;
    const pluginName = manifest.name;
    const _targetPath = path.join(this.pluginsDir, `${pluginName}@local`);

    try {
      // For local source, we could copy or symlink
      // For now, we just validate and return the path
      return { success: true, path: localPath };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: { type: 'git-clone-failed', message } };
    }
  }

  /**
   * Install or update a plugin from a remote git host
   * @param host - Git host domain (e.g. github.com, gitee.com)
   * @param repo - Repository path (e.g. user/repo)
   * @param suffix - Directory suffix (@github, @gitee, @gitlab)
   * @param ref - Optional branch/tag/commit
   */
  private async installRemote(host: string, repo: string, suffix: string, ref?: string): Promise<{ success: boolean; path?: string; error?: PluginError }> {
    const pluginName = this.extractPluginName(repo);
    const targetPath = path.join(this.pluginsDir, `${pluginName}${suffix}`);

    try {
      if (fs.existsSync(targetPath)) {
        const git = simpleGit(targetPath);
        await git.fetch();
        if (ref) {
          await git.checkout(ref);
          await git.pull('origin', ref);
        } else {
          await git.pull();
        }

        const validation = this.validate(targetPath);
        if (!validation.valid) {
          fs.rmSync(targetPath, { recursive: true, force: true });
          return { success: false, error: validation.error };
        }

        return { success: true, path: targetPath };
      }

      // Fresh clone
      const cloneOptions: string[] = [];
      if (ref) {
        cloneOptions.push('--branch', ref);
      }
      cloneOptions.push('--single-branch');

      await this.git.clone(`https://${host}/${repo}.git`, targetPath, cloneOptions);

      const validation = this.validate(targetPath);
      if (!validation.valid) {
        fs.rmSync(targetPath, { recursive: true, force: true });
        return { success: false, error: validation.error };
      }

      if (ref) {
        const git = simpleGit(targetPath);
        await git.checkout(ref);
      }

      return { success: true, path: targetPath };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (fs.existsSync(targetPath)) {
        fs.rmSync(targetPath, { recursive: true, force: true });
      }
      return { success: false, error: { type: 'git-clone-failed', message } };
    }
  }

  /**
   * Reset a plugin to its remote state — discards all local modifications
   * Always performs git reset --hard + git clean, regardless of whether
   * there are new commits. This is for users who want to undo local edits.
   */
  async reset(name: string, targetPath?: string): Promise<UpdateResult> {
    // If path is not provided, resolve by name
    if (!targetPath) {
      const resolved = this.resolvePluginDir(name);
      if (!resolved) {
        return { success: false, error: { type: 'plugin-not-found', name } };
      }
      if (resolved.source === 'local') {
        return { success: false, error: { type: 'git-clone-failed', message: 'Local plugins cannot be reset' } };
      }
      targetPath = resolved.path;
    }

    try {
      const git = simpleGit(targetPath);
      await git.fetch();

      const branchSummary = await git.branch();
      const currentBranch = branchSummary.current;
      const remoteRef = `origin/${currentBranch}`;

      // Force reset to remote state
      await git.reset(['--hard', remoteRef]);
      await git.clean('f', ['-d']);

      const err = this.validateOrError(targetPath);
      if (err) return { success: false, error: err };

      return { success: true, path: targetPath, updated: true, forceApplied: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: { type: 'git-clone-failed', message } };
    }
  }

  /**
   * Uninstall a plugin by name — removes the plugin directory
   */
  async uninstall(name: string): Promise<{ success: boolean; error?: PluginError }> {
    const resolved = this.resolvePluginDir(name);
    if (!resolved) {
      return { success: false, error: { type: 'plugin-not-found', name } };
    }

    try {
      fs.rmSync(resolved.path, { recursive: true, force: true });
      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: { type: 'git-clone-failed', message: `Failed to remove plugin: ${message}` } };
    }
  }

  /**
   * Update a plugin from its git repository
   *
   * Normal mode (force=false):
   *   - git fetch, check for new commits
   *   - If already up-to-date → { updated: false }
   *   - If working tree is clean → git pull → { updated: true }
   *   - If working tree is dirty → { dirtyFiles, error } with list of modified files
   *
   * Force mode (force=true):
   *   - git fetch + git reset --hard origin/<branch> + git clean -fd
   *   - Discards all local changes → { updated: true, forceApplied: true }
   */
  async update(name: string, options?: UpdateOptions): Promise<UpdateResult> {
    const resolved = this.resolvePluginDir(name);
    if (!resolved) {
      return { success: false, error: { type: 'plugin-not-found', name } };
    }
    if (resolved.source === 'local') {
      return { success: false, error: { type: 'git-clone-failed', message: 'Local plugins cannot be updated via git pull' } };
    }

    const targetPath = resolved.path;

    const force = options?.force ?? false;

    try {
      const git = simpleGit(targetPath);
      await git.fetch();

      const branchSummary = await git.branch();
      const currentBranch = branchSummary.current;
      const remoteRef = `origin/${currentBranch}`;

      const revCount = await git.raw(['rev-list', '--count', `HEAD..${remoteRef}`]);
      const hasNewCommits = parseInt(revCount.trim(), 10) > 0;

      if (!hasNewCommits) {
        return { success: true, path: targetPath, updated: false };
      }

      if (force) {
        await git.reset(['--hard', remoteRef]);
        await git.clean('f', ['-d']);

        const err = this.validateOrError(targetPath);
        if (err) return { success: false, error: err };

        return { success: true, path: targetPath, updated: true, forceApplied: true };
      }

      const status = await git.status();
      if (!status.isClean()) {
        const dirtyFiles = status.files.map(f => f.path);
        return {
          success: false,
          path: targetPath,
          dirtyFiles,
          error: {
            type: 'git-clone-failed',
            message: `Working tree has ${dirtyFiles.length} local modification(s). Use force mode to discard them.`
          }
        };
      }

      await git.pull();

      const err = this.validateOrError(targetPath);
      if (err) return { success: false, error: err };

      return { success: true, path: targetPath, updated: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: { type: 'git-clone-failed', message } };
    }
  }

  /**
   * Validate a plugin directory and return a PluginError if invalid.
   * Returns null when valid — enables clean early-return checks.
   */
  private validateOrError(pluginPath: string): PluginError | null {
    const validation = this.validate(pluginPath);
    return validation.valid ? null : validation.error ?? null;
  }

  /**
   * Validate a plugin by checking for valid plugin.json
   * Supports both .claude-plugin/plugin.json (HClaw convention) and root plugin.json (open source convention)
   */
  validate(pluginPath: string): { valid: boolean; manifest?: PluginManifest; error?: PluginError } {
      const claudePluginManifestPath = path.join(pluginPath, '.claude-plugin', 'plugin.json');
      const rootManifestPath = path.join(pluginPath, 'plugin.json');

      let manifestPath: string;
      if (fs.existsSync(claudePluginManifestPath)) {
          manifestPath = claudePluginManifestPath;
      } else if (fs.existsSync(rootManifestPath)) {
          manifestPath = rootManifestPath;
      } else {
          return {
              valid: false,
              error: {type: 'manifest-not-found', path: `${claudePluginManifestPath} or ${rootManifestPath}`}
          };
    }

    try {
        const content = fs.readFileSync(manifestPath, 'utf-8');
      const manifest = JSON.parse(content) as PluginManifest;

      // Validate required fields
      const errors: string[] = [];
      if (!manifest.name || typeof manifest.name !== 'string') {
        errors.push('Missing or invalid "name" field in plugin.json');
      }

      if (errors.length > 0) {
        return { valid: false, error: { type: 'manifest-invalid', errors } };
      }

      return { valid: true, manifest };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { valid: false, error: { type: 'manifest-invalid', errors: [`Failed to parse plugin.json: ${message}`] } };
    }
  }

  /**
   * Parse a GitHub URL into a PluginSource
   * Supports formats:
   * - https://github.com/user/repo
   * - https://github.com/user/repo.git
   * - https://github.com/user/repo/tree/branch
   * - git@github.com:user/repo.git
   */
  parseGithubUrl(url: string): PluginSource | null {
    // HTTPS URL patterns
    const httpsMatch = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/tree\/([^/]+))?$/);
    if (httpsMatch) {
      const [, owner, repo, ref] = httpsMatch;
      return {
        source: 'github',
        repo: `${owner}/${repo.replace(/\.git$/, '')}`,
        ref,
      };
    }

    // SSH URL pattern
    const sshMatch = url.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/);
    if (sshMatch) {
      const [, owner, repo] = sshMatch;
      return {
        source: 'github',
        repo: `${owner}/${repo.replace(/\.git$/, '')}`,
      };
    }

    // Try to parse as owner/repo format directly
    const directMatch = url.match(/^([^/]+)\/([^/]+)$/);
    if (directMatch) {
      return {
        source: 'github',
        repo: url,
      };
    }

    return null;
  }

  /**
   * Extract plugin name from a repo string (e.g., "user/repo" -> "repo")
   */
  extractPluginName(repo: string): string {
    const parts = repo.split('/');
    return parts[parts.length - 1].replace(/\.git$/, '');
  }

  /** Find a plugin directory by name, trying all known suffixes first, then fallback to scanning all directories */
  private resolvePluginDir(name: string): { path: string; source: string } | null {
    // Fast path: try known suffix naming convention
    for (const [source, info] of Object.entries(PluginInstaller.HOST_MAP)) {
      const targetPath = path.join(this.pluginsDir, `${name}${info.suffix}`);
      if (fs.existsSync(targetPath)) return { path: targetPath, source };
    }
    const localPath = path.join(this.pluginsDir, `${name}@local`);
    if (fs.existsSync(localPath)) return { path: localPath, source: 'local' };

    // Fallback: scan all directories in plugins/ and match by manifest name
    // This handles cases where the directory name (from repo) differs from the manifest name
    try {
      const entries = fs.readdirSync(this.pluginsDir, {withFileTypes: true});
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const dirPath = path.join(this.pluginsDir, entry.name);

        // Try to read manifest and match name
        const manifestPaths = [
          path.join(dirPath, '.claude-plugin', 'plugin.json'),
          path.join(dirPath, 'plugin.json'),
        ];

        for (const manifestPath of manifestPaths) {
          if (!fs.existsSync(manifestPath)) continue;
          try {
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
            if (manifest.name === name) {
              const source = Object.entries(PluginInstaller.HOST_MAP).find(([, info]) => entry.name.endsWith(info.suffix))?.[0] ?? 'local';
              return { path: dirPath, source };
            }
          } catch { /* skip unparseable manifests */ }
        }
      }
    } catch { /* plugins dir not found or unreadable */ }

    return null;
  }

  /**
   * Parse a Gitee URL into a PluginSource
   * https://gitee.com/user/repo[/tree/branch]
   */
  parseGiteeUrl(url: string): PluginSource | null {
    const httpsMatch = url.match(/^https:\/\/gitee\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/tree\/([^/]+))?$/);
    if (httpsMatch) {
      const [, owner, repo, ref] = httpsMatch;
      return { source: 'gitee', repo: `${owner}/${repo.replace(/\.git$/, '')}`, ref };
    }
    return null;
  }

  /**
   * Parse a GitLab URL into a PluginSource
   * https://gitlab.com/user/repo[/-/tree/branch]
   */
  parseGitlabUrl(url: string): PluginSource | null {
    const httpsMatch = url.match(/^https:\/\/gitlab\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/-\/tree\/([^/]+))?$/);
    if (httpsMatch) {
      const [, owner, repo, ref] = httpsMatch;
      return { source: 'gitlab', repo: `${owner}/${repo.replace(/\.git$/, '')}`, ref };
    }
    return null;
  }
}
