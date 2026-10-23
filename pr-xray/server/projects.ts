// Maps a PR's repository to the bb project that holds a checkout of it.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { PrRef } from "../shared/schema";

export interface ProjectMatch {
  projectId: string;
  projectName: string;
  hostId: string | null;
  path: string | null;
}

function normalizeRemote(url: string): string | null {
  const match = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/iu.exec(url.trim());
  return match === null ? null : `${match[1]}/${match[2]}`.toLowerCase();
}

export async function findProject(bb: BbPluginApi, ref: PrRef): Promise<ProjectMatch | null> {
  const wanted = `${ref.owner}/${ref.repo}`.toLowerCase();
  const projects = await bb.sdk.projects.list();
  for (const project of projects) {
    const remote = (project as { gitRemoteUrl?: string | null }).gitRemoteUrl;
    if (!remote || normalizeRemote(remote) !== wanted) continue;
    const sources = (project as { sources?: { type: string; hostId: string; path?: string; isDefault?: boolean }[] })
      .sources ?? [];
    const source = sources.find((candidate) => candidate.isDefault) ?? sources[0];
    return {
      projectId: project.id,
      projectName: project.name,
      hostId: source?.hostId ?? null,
      path: source?.type === "local_path" ? (source.path ?? null) : null,
    };
  }
  return null;
}

export async function personalProjectId(bb: BbPluginApi): Promise<string> {
  const projects = await bb.sdk.projects.list({ includePersonal: true });
  const personal = projects.find((project) => (project as { kind?: string }).kind === "personal");
  if (personal === undefined) throw new Error("No personal project to run the analysis in.");
  return personal.id;
}
