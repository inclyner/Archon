/**
 * Auto-detect the dev command for a member worktree.
 *
 * Looks at the on-disk repo to figure out the right `cd <path> && <cmd>`
 * incantation. Covers the user's actual stack (Node/pnpm, .NET, Python uv);
 * everything else returns null and the user has to fill in a custom command.
 *
 * Why heuristic instead of explicit per-codebase config: avoiding a schema
 * change for the v1 of dev-server runner. If real use turns up edge cases
 * (mono-projects with multiple dev targets, custom scripts), we add a
 * `dev_config` JSONB column and a UI editor in a follow-up. Until then,
 * detection covers ~90% of the user's actual repos.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

export interface DevCommandSpec {
  /** Absolute working directory the command should run in. */
  cwd: string;
  /** Command + args. */
  command: string;
  args: string[];
  /**
   * Env var name the command reads to bind to a specific port (e.g. `PORT`,
   * `ASPNETCORE_URLS`). The runner injects the allocated port via this var.
   * If null, the command picks its own port and we read it from the logs
   * (best-effort; user may need to override).
   */
  portEnvVar: string | null;
  /**
   * Format for the port value. `number` = bare integer, `kestrelUrl` =
   * `http://*:N` for ASPNETCORE_URLS.
   */
  portFormat: 'number' | 'kestrelUrl';
  /**
   * Human-readable label for the UI ("front-end", "api", ...). Just the
   * member's relative path; the API derives this from the codebase row.
   */
  label?: string;
  /**
   * Substrings the runner can grep for in stdout/stderr to detect the
   * server is *actually* ready (vs just spawned). Optional but improves UX
   * — if missing, the UI shows "spawned" without a "ready" state.
   */
  readinessMarkers?: string[];
}

/**
 * Detect the dev command for a member worktree. Returns null if nothing
 * obvious is present at the worktree root and the user needs to configure
 * one manually.
 */
export function detectDevCommand(memberDir: string): DevCommandSpec | null {
  // 1) Node: package.json with a `dev` script. pnpm → npm fallback.
  const pkgPath = join(memberDir, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
        scripts?: Record<string, string>;
      };
      if (pkg.scripts?.dev) {
        // Prefer pnpm when there's a pnpm-lock.yaml; otherwise npm. Yarn is
        // intentionally not auto-detected — the user's repos all use pnpm.
        const usesPnpm = existsSync(join(memberDir, 'pnpm-lock.yaml'));
        return {
          cwd: memberDir,
          command: usesPnpm ? 'pnpm' : 'npm',
          args: usesPnpm ? ['dev'] : ['run', 'dev'],
          portEnvVar: 'PORT',
          portFormat: 'number',
          // Next.js 14+, Vite, CRA all log similar markers.
          readinessMarkers: ['ready', 'compiled successfully', 'Local:', 'Listening on'],
        };
      }
    } catch {
      // malformed package.json — fall through to other detectors
    }
  }

  // 2) Python uv with FastAPI/uvicorn. Heuristic: pyproject.toml mentions
  //    fastapi or uvicorn. Reads the file as text rather than parsing TOML
  //    to avoid pulling in a dep just for one substring check.
  const pyprojPath = join(memberDir, 'pyproject.toml');
  if (existsSync(pyprojPath)) {
    try {
      const py = readFileSync(pyprojPath, 'utf8').toLowerCase();
      if (py.includes('uvicorn') || py.includes('fastapi')) {
        // Convention from the user's digital-walter repo: app.main:app entry.
        // If the user's repo uses a different entry point this will fail
        // and they'll need to override manually.
        return {
          cwd: memberDir,
          command: 'uv',
          args: [
            'run',
            'uvicorn',
            'app.main:app',
            '--reload',
            '--host',
            '0.0.0.0',
            '--port',
            'PORT_PLACEHOLDER',
          ],
          portEnvVar: 'UVICORN_PORT', // not actually read; we replace PORT_PLACEHOLDER
          portFormat: 'number',
          readinessMarkers: ['Application startup complete', 'Uvicorn running on'],
        };
      }
    } catch {
      // ignore
    }
  }

  // 3) .NET — find a *.csproj with Web SDK (the API; not class libs). For
  //    the Rimon repos this lives in a `<repo>/Rimon.Api.Server/` subdir;
  //    we walk one level deep to find it.
  const csprojSpec = findDotnetWebProject(memberDir);
  if (csprojSpec) return csprojSpec;

  return null;
}

function findDotnetWebProject(repoDir: string): DevCommandSpec | null {
  // Quick check at the top level.
  const direct = scanDirForWebCsproj(repoDir);
  if (direct) {
    return makeDotnetSpec(direct);
  }
  // One level deep: many .NET solutions live in a subdir per project.
  let entries: string[];
  try {
    entries = readdirSync(repoDir);
  } catch {
    return null;
  }
  for (const name of entries) {
    if (name.startsWith('.')) continue;
    const sub = join(repoDir, name);
    let isDir = false;
    try {
      isDir = statSync(sub).isDirectory();
    } catch {
      // ignore
    }
    if (!isDir) continue;
    const found = scanDirForWebCsproj(sub);
    if (found) return makeDotnetSpec(found);
  }
  return null;
}

function scanDirForWebCsproj(dir: string): string | null {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  for (const name of entries) {
    if (!name.endsWith('.csproj')) continue;
    const full = join(dir, name);
    try {
      const xml = readFileSync(full, 'utf8');
      // The Microsoft.NET.Sdk.Web SDK is the marker for ASP.NET projects;
      // class libraries use Microsoft.NET.Sdk and don't host Kestrel.
      if (xml.includes('Microsoft.NET.Sdk.Web')) return full;
    } catch {
      // ignore unreadable file
    }
  }
  return null;
}

function makeDotnetSpec(csprojPath: string): DevCommandSpec {
  // dotnet watch run --project <csproj> respects ASPNETCORE_URLS for binding.
  return {
    cwd: csprojPath.replace(/[/\\][^/\\]+\.csproj$/, ''),
    command: 'dotnet',
    args: ['watch', 'run', '--project', csprojPath],
    portEnvVar: 'ASPNETCORE_URLS',
    portFormat: 'kestrelUrl',
    readinessMarkers: ['Now listening on', 'Application started', 'Hosting environment'],
  };
}
