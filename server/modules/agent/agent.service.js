import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';

import spawn from 'cross-spawn';

async function getGitRemoteUrl(repoPath) {
  return new Promise((resolve, reject) => {
    const gitProcess = spawn('git', ['config', '--get', 'remote.origin.url'], {
      cwd: repoPath,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    gitProcess.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    gitProcess.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    gitProcess.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(`Failed to get git remote: ${stderr}`));
      }
    });

    gitProcess.on('error', (error) => {
      reject(new Error(`Failed to execute git: ${error.message}`));
    });
  });
}

/**
 * Normalize GitHub URLs for comparison
 * @param {string} url - GitHub URL
 * @returns {string} - Normalized URL
 */
function normalizeGitHubUrl(url) {
  // Remove .git suffix
  let normalized = url.replace(/\.git$/, '');
  // Convert SSH to HTTPS format for comparison
  normalized = normalized.replace(/^git@github\.com:/, 'https://github.com/');
  // Remove trailing slash
  normalized = normalized.replace(/\/$/, '');
  return normalized.toLowerCase();
}

/**
 * Parse GitHub URL to extract owner and repo
 * @param {string} url - GitHub URL (HTTPS or SSH)
 * @returns {{owner: string, repo: string}} - Parsed owner and repo
 */
function parseGitHubUrl(url) {
  // Handle HTTPS URLs: https://github.com/owner/repo or https://github.com/owner/repo.git
  // Handle SSH URLs: git@github.com:owner/repo or git@github.com:owner/repo.git
  const match = url.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (!match) {
    throw new Error('Invalid GitHub URL format');
  }
  return {
    owner: match[1],
    repo: match[2].replace(/\.git$/, '')
  };
}

/**
 * Auto-generate a branch name from a message
 * @param {string} message - The agent message
 * @returns {string} - Generated branch name
 */
function autogenerateBranchName(message) {
  // Convert to lowercase, replace spaces/special chars with hyphens
  let branchName = message
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '') // Remove special characters
    .replace(/\s+/g, '-') // Replace spaces with hyphens
    .replace(/-+/g, '-') // Replace multiple hyphens with single
    .replace(/^-|-$/g, ''); // Remove leading/trailing hyphens

  // Ensure non-empty fallback
  if (!branchName) {
    branchName = 'task';
  }

  // Generate timestamp suffix (last 6 chars of base36 timestamp)
  const timestamp = Date.now().toString(36).slice(-6);
  const suffix = `-${timestamp}`;

  // Limit length to ensure total length including suffix fits within 50 characters
  const maxBaseLength = 50 - suffix.length;
  if (branchName.length > maxBaseLength) {
    branchName = branchName.substring(0, maxBaseLength);
  }

  // Remove any trailing hyphen after truncation and ensure no leading hyphen
  branchName = branchName.replace(/-$/, '').replace(/^-+/, '');

  // If still empty or starts with hyphen after cleanup, use fallback
  if (!branchName || branchName.startsWith('-')) {
    branchName = 'task';
  }

  // Combine base name with timestamp suffix
  branchName = `${branchName}${suffix}`;

  // Final validation: ensure it matches safe pattern
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(branchName)) {
    // Fallback to deterministic safe name
    return `branch-${timestamp}`;
  }

  return branchName;
}

/**
 * Validate a Git branch name
 * @param {string} branchName - Branch name to validate
 * @returns {{valid: boolean, error?: string}} - Validation result
 */
function validateBranchName(branchName) {
  if (!branchName || branchName.trim() === '') {
    return { valid: false, error: 'Branch name cannot be empty' };
  }

  // Git branch name rules
  const invalidPatterns = [
    { pattern: /^\./, message: 'Branch name cannot start with a dot' },
    { pattern: /\.$/, message: 'Branch name cannot end with a dot' },
    { pattern: /\.\./, message: 'Branch name cannot contain consecutive dots (..)' },
    { pattern: /\s/, message: 'Branch name cannot contain spaces' },
    { pattern: /[~^:?*\[\\]/, message: 'Branch name cannot contain special characters: ~ ^ : ? * [ \\' },
    { pattern: /@{/, message: 'Branch name cannot contain @{' },
    { pattern: /\/$/, message: 'Branch name cannot end with a slash' },
    { pattern: /^\//, message: 'Branch name cannot start with a slash' },
    { pattern: /\/\//, message: 'Branch name cannot contain consecutive slashes' },
    { pattern: /\.lock$/, message: 'Branch name cannot end with .lock' }
  ];

  for (const { pattern, message } of invalidPatterns) {
    if (pattern.test(branchName)) {
      return { valid: false, error: message };
    }
  }

  // Check for ASCII control characters
  if (/[\x00-\x1F\x7F]/.test(branchName)) {
    return { valid: false, error: 'Branch name cannot contain control characters' };
  }

  return { valid: true };
}

/**
 * Get recent commit messages from a repository
 * @param {string} projectPath - Path to the git repository
 * @param {number} limit - Number of commits to retrieve (default: 5)
 * @returns {Promise<string[]>} - Array of commit messages
 */
async function getCommitMessages(projectPath, limit = 5) {
  return new Promise((resolve, reject) => {
    const gitProcess = spawn('git', ['log', `-${limit}`, '--pretty=format:%s'], {
      cwd: projectPath,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    gitProcess.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    gitProcess.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    gitProcess.on('close', (code) => {
      if (code === 0) {
        const messages = stdout.trim().split('\n').filter(msg => msg.length > 0);
        resolve(messages);
      } else {
        reject(new Error(`Failed to get commit messages: ${stderr}`));
      }
    });

    gitProcess.on('error', (error) => {
      reject(new Error(`Failed to execute git: ${error.message}`));
    });
  });
}

/**
 * Create a new branch on GitHub using the API
 * @param {Octokit} octokit - Octokit instance
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @param {string} branchName - Name of the new branch
 * @param {string} baseBranch - Base branch to branch from (default: 'main')
 * @returns {Promise<void>}
 */
async function createGitHubBranch(octokit, owner, repo, branchName, baseBranch = 'main') {
  try {
    // Get the SHA of the base branch
    const { data: ref } = await octokit.git.getRef({
      owner,
      repo,
      ref: `heads/${baseBranch}`
    });

    const baseSha = ref.object.sha;

    // Create the new branch
    await octokit.git.createRef({
      owner,
      repo,
      ref: `refs/heads/${branchName}`,
      sha: baseSha
    });

    console.log(`✅ Created branch '${branchName}' on GitHub`);
  } catch (error) {
    if (error.status === 422 && error.message.includes('Reference already exists')) {
      console.log(`ℹ️ Branch '${branchName}' already exists on GitHub`);
    } else {
      throw error;
    }
  }
}

/**
 * Create a pull request on GitHub
 * @param {Octokit} octokit - Octokit instance
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @param {string} branchName - Head branch name
 * @param {string} title - PR title
 * @param {string} body - PR body/description
 * @param {string} baseBranch - Base branch (default: 'main')
 * @returns {Promise<{number: number, url: string}>} - PR number and URL
 */
async function createGitHubPR(octokit, owner, repo, branchName, title, body, baseBranch = 'main') {
  const { data: pr } = await octokit.pulls.create({
    owner,
    repo,
    title,
    head: branchName,
    base: baseBranch,
    body
  });

  console.log(`✅ Created pull request #${pr.number}: ${pr.html_url}`);

  return {
    number: pr.number,
    url: pr.html_url
  };
}

/**
 * Clone a GitHub repository to a directory
 * @param {string} githubUrl - GitHub repository URL
 * @param {string} githubToken - Optional GitHub token for private repos
 * @param {string} projectPath - Path for cloning the repository
 * @returns {Promise<string>} - Path to the cloned repository
 */
async function cloneGitHubRepo(githubUrl, githubToken = null, projectPath) {
  return new Promise(async (resolve, reject) => {
    try {
      // Validate GitHub URL
      if (!githubUrl || !githubUrl.includes('github.com')) {
        throw new Error('Invalid GitHub URL');
      }

      const cloneDir = path.resolve(projectPath);

      // Check if directory already exists
      try {
        await fs.access(cloneDir);
        // Directory exists - check if it's a git repo with the same URL
        try {
          const existingUrl = await getGitRemoteUrl(cloneDir);
          const normalizedExisting = normalizeGitHubUrl(existingUrl);
          const normalizedRequested = normalizeGitHubUrl(githubUrl);

          if (normalizedExisting === normalizedRequested) {
            console.log('✅ Repository already exists at path with correct URL');
            return resolve(cloneDir);
          } else {
            throw new Error(`Directory ${cloneDir} already exists with a different repository (${existingUrl}). Expected: ${githubUrl}`);
          }
        } catch (gitError) {
          throw new Error(`Directory ${cloneDir} already exists but is not a valid git repository or git command failed`);
        }
      } catch (accessError) {
        // Directory doesn't exist - proceed with clone
      }

      // Ensure parent directory exists
      await fs.mkdir(path.dirname(cloneDir), { recursive: true });

      // Prepare the git clone URL with authentication if token is provided
      let cloneUrl = githubUrl;
      if (githubToken) {
        // Convert HTTPS URL to authenticated URL
        // Example: https://github.com/user/repo -> https://token@github.com/user/repo
        cloneUrl = githubUrl.replace('https://github.com', `https://${githubToken}@github.com`);
      }

      console.log('🔄 Cloning repository:', githubUrl);
      console.log('📁 Destination:', cloneDir);

      // Execute git clone
      const gitProcess = spawn('git', ['clone', '--depth', '1', cloneUrl, cloneDir], {
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';

      gitProcess.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      gitProcess.stderr.on('data', (data) => {
        stderr += data.toString();
        console.log('Git stderr:', data.toString());
      });

      gitProcess.on('close', (code) => {
        if (code === 0) {
          console.log('✅ Repository cloned successfully');
          resolve(cloneDir);
        } else {
          console.error('❌ Git clone failed:', stderr);
          reject(new Error(`Git clone failed: ${stderr}`));
        }
      });

      gitProcess.on('error', (error) => {
        reject(new Error(`Failed to execute git: ${error.message}`));
      });
    } catch (error) {
      reject(error);
    }
  });
}

/**
 * Clean up a temporary project directory and its Claude session
 * @param {string} projectPath - Path to the project directory
 * @param {string} sessionId - Session ID to clean up
 */
async function cleanupProject(projectPath, sessionId = null) {
  try {
    // Only clean up projects in the external-projects directory
    if (!projectPath.includes('.claude/external-projects')) {
      console.warn('⚠️ Refusing to clean up non-external project:', projectPath);
      return;
    }

    console.log('🧹 Cleaning up project:', projectPath);
    await fs.rm(projectPath, { recursive: true, force: true });
    console.log('✅ Project cleaned up');

    // Also clean up the Claude session directory if sessionId provided
    if (sessionId) {
      try {
        const sessionPath = path.join(os.homedir(), '.claude', 'sessions', sessionId);
        console.log('🧹 Cleaning up session directory:', sessionPath);
        await fs.rm(sessionPath, { recursive: true, force: true });
        console.log('✅ Session directory cleaned up');
      } catch (error) {
        console.error('⚠️ Failed to clean up session directory:', error.message);
      }
    }
  } catch (error) {
    console.error('❌ Failed to clean up project:', error);
  }
}

/**
 * SSE Stream Writer - Adapts SDK/CLI output to Server-Sent Events
 */
class SSEStreamWriter {
  constructor(res, userId = null) {
    this.res = res;
    this.sessionId = null;
    this.userId = userId;
    this.isSSEStreamWriter = true;  // Marker for transport detection
  }

  send(data) {
    if (this.res.writableEnded) {
      return;
    }

    // Format as SSE - providers send raw objects, we stringify
    this.res.write(`data: ${JSON.stringify(data)}\n\n`);
  }

  end() {
    if (!this.res.writableEnded) {
      this.res.write('data: {"type":"done"}\n\n');
      this.res.end();
    }
  }

  setSessionId(sessionId) {
    this.sessionId = sessionId;
    this.send({ type: 'session-id', sessionId });
  }

  getSessionId() {
    return this.sessionId;
  }
}

/**
 * Non-streaming response collector
 */
class ResponseCollector {
  constructor(userId = null) {
    this.messages = [];
    this.sessionId = null;
    this.userId = userId;
  }

  send(data) {
    // Store ALL messages for now - we'll filter when returning
    this.messages.push(data);

    // Extract sessionId if present
    if (typeof data === 'string') {
      try {
        const parsed = JSON.parse(data);
        if (parsed.sessionId) {
          this.sessionId = parsed.sessionId;
        }
      } catch (e) {
        // Not JSON, ignore
      }
    } else if (data && data.sessionId) {
      this.sessionId = data.sessionId;
    }
  }

  end() {
    // Do nothing - we'll collect all messages
  }

  setSessionId(sessionId) {
    this.sessionId = sessionId;
  }

  getSessionId() {
    return this.sessionId;
  }

  getMessages() {
    return this.messages;
  }

  /**
   * Get filtered assistant messages only
   */
  getAssistantMessages() {
    const assistantMessages = [];

    for (const msg of this.messages) {
      // Skip initial status message
      if (msg && msg.type === 'status') {
        continue;
      }

      // Handle JSON strings
      if (typeof msg === 'string') {
        try {
          const parsed = JSON.parse(msg);
          // Only include claude-response messages with assistant type
          if (parsed.type === 'claude-response' && parsed.data && parsed.data.type === 'assistant') {
            assistantMessages.push(parsed.data);
          }
        } catch (e) {
          // Not JSON, skip
        }
      }
    }

    return assistantMessages;
  }

  /**
   * Calculate total tokens from all messages
   */
  getTotalTokens() {
    let totalInput = 0;
    let totalOutput = 0;
    let totalCacheRead = 0;
    let totalCacheCreation = 0;

    for (const msg of this.messages) {
      let data = msg;

      // Parse if string
      if (typeof msg === 'string') {
        try {
          data = JSON.parse(msg);
        } catch (e) {
          continue;
        }
      }

      // Extract usage from claude-response messages
      if (data && data.type === 'claude-response' && data.data) {
        const msgData = data.data;
        if (msgData.message && msgData.message.usage) {
          const usage = msgData.message.usage;
          totalInput += usage.input_tokens || 0;
          totalOutput += usage.output_tokens || 0;
          totalCacheRead += usage.cache_read_input_tokens || 0;
          totalCacheCreation += usage.cache_creation_input_tokens || 0;
        }
      }
    }

    const inputTokens = totalInput + totalCacheRead + totalCacheCreation;

    return {
      inputTokens,
      outputTokens: totalOutput,
      cacheReadTokens: totalCacheRead,
      cacheCreationTokens: totalCacheCreation,
      totalTokens: inputTokens + totalOutput
    };
  }
}



export {
  autogenerateBranchName,
  cleanupProject,
  cloneGitHubRepo,
  createGitHubBranch,
  createGitHubPR,
  getCommitMessages,
  getGitRemoteUrl,
  normalizeGitHubUrl,
  parseGitHubUrl,
  ResponseCollector,
  SSEStreamWriter,
  validateBranchName,
};
